"""Daily read-only, same-state comparison against injector logs and SQLite.

This is an operator tool, not a service entry point. All DB connections use
mode=ro and query_only. The shadow log supplies the envelope appearance time;
SQLite alone cannot recover historical decisions overwritten by upserts.
"""
import argparse
from collections import Counter
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3


def open_injector(path: Path | str) -> sqlite3.Connection:
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    return connection


def epoch_ms(value: str) -> int:
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamps must include a timezone')
    return int(parsed.timestamp() * 1000)


def _decision(value):
    action = value['action']
    if action not in ('steer', 'enqueue', 'launch', 'preempt', 'hold', 'defer', 'skip', 'fail', 'cannot_decide'):
        raise ValueError(f'unknown shadow decision: {action}')
    if not value.get('reason'):
        raise ValueError('decision.reason is required')
    if action == 'cannot_decide' and not value.get('missing_fact'):
        raise ValueError('cannot_decide requires decision.missing_fact')
    return action


def _difference(row):
    difference = row.get('difference')
    if difference is None:
        return None
    if difference.get('kind') == 'design':
        if not difference.get('reason'):
            raise ValueError('design difference requires reason (approved rule change)')
    elif difference.get('kind') == 'missing_data':
        if not difference.get('field'):
            raise ValueError('missing_data difference requires field')
    else:
        raise ValueError('difference.kind must be design or missing_data')
    return difference


def _door(door):
    return {'steer': 'steer', 'enqueue': 'enqueue', 'launch': 'launch',
            'invoke': 'launch', 'preempt': 'preempt'}.get(door)


def _diagnostic(diagnostic, intent):
    outcome = diagnostic['outcome']
    # Observed on max3: admitted, seat_starting, seat_turn-observed, seat_unavailable.
    # Other deferred paths are explicit recordDeferredDiagnostic calls in target-driver.ts.
    if outcome in ('seat_starting', 'seat_stopping', 'seat_unavailable',
                   'seat_turn-observed', 'broker_probe_failed'):
        return 'defer'
    if outcome == 'admitted' and intent is not None:
        # 'admitted' says no door. A stale intent from another runtime cannot supply it.
        if diagnostic['runtime_id'] == intent['runtime_id'] and epoch_ms(intent['submitted_at']) <= epoch_ms(diagnostic['created_at']):
            return _door(intent['door'])
    # Hold/skip are currently target completion LOGS, not rows in this table.
    return None


def _evidence(c, envelope_id, decided_at):
    intent_row = c.execute('''SELECT envelope_id, door, runtime_id, generation,
        delivery_outcome, submitted_at FROM hrcmail_delivery_intents WHERE envelope_id=?''',
        (envelope_id,)).fetchone()
    diagnostic_row = c.execute('''SELECT envelope_id, target_session_ref, wake_reason,
        outcome, observed_seat_state, runtime_id, created_at
        FROM hrcmail_drive_diagnostics WHERE envelope_id=?''', (envelope_id,)).fetchone()
    intent = dict(intent_row) if intent_row else None
    diagnostic = dict(diagnostic_row) if diagnostic_row else None
    candidates = []
    if intent is not None:
        candidates.append((intent['submitted_at'], _door(intent['door']), 'intent', intent['door']))
    if diagnostic is not None:
        candidates.append((diagnostic['created_at'], _diagnostic(diagnostic, intent),
                           'diagnostic', diagnostic['outcome']))
    if not candidates:
        return intent, diagnostic, None
    # Compare the observation closest to this shadow decision. Both original rows
    # remain in the report, including an unknown closer diagnostic (never hidden).
    selected = min(candidates, key=lambda x: (abs(epoch_ms(x[0]) - decided_at), x[2]))
    return intent, diagnostic, selected


def comparison(shadow, intent, diagnostic, legacy_evidence, log_evidence, state_until=None):
    evidence = legacy_evidence
    records = []
    if 'envelope_state' in shadow:
        candidates = []
        if intent:
            candidates.append((intent['submitted_at'], _door(intent['door']), 'intent', intent['door']))
        if diagnostic:
            candidates.append((diagnostic['created_at'], _diagnostic(diagnostic, intent),
                               'diagnostic', diagnostic['outcome']))
        selected = log_evidence.match(shadow, candidates, state_until)
        evidence = ((selected['at'], selected['action'], selected['source'], selected['label'])
                    if selected else None)
        records = selected['records'] if selected else []
    actual = evidence[1] if evidence else None
    action = shadow['decision']['action']
    difference = shadow.get('difference')
    missing = None
    kind = None
    if action == 'cannot_decide':
        classification, kind = 'cannot_decide', 'shadow_input_gap'
        missing = shadow['decision']['missing_fact']
    elif evidence is None and 'envelope_state' in shadow:
        classification = 'pending_evidence'
    elif actual is None:
        classification, kind = 'cannot_decide', 'injector_evidence_unmapped'
        missing = 'injector.outcome_mapping' if evidence else 'injector.evidence'
    elif action == actual:
        classification = 'agreed'
    elif difference and difference['kind'] == 'design':
        classification = 'differed_by_design'
    elif difference and difference['kind'] == 'missing_data':
        classification = 'differed_missing_data'
        missing = difference['field']
    else:
        classification = 'differed_defect'
    return dict(classification=classification, cannot_decide_kind=kind, missing_field=missing,
                evidence=list(evidence) if evidence else None,
                injector_log_evidence=records, injector_decision=actual)


def score(shadow_log: Path | str, injector_db: Path | str, day: str, *, since=None, until=None,
          injector_log=None) -> dict:
    from .evidence import InjectorEvidence
    log_evidence = InjectorEvidence(injector_log)
    start = datetime.combine(date.fromisoformat(day), datetime.min.time(), timezone.utc)
    begin = int(start.timestamp() * 1000)
    end = int((start + timedelta(days=1)).timestamp() * 1000)
    begin = max(begin, epoch_ms(since)) if since else begin
    end = min(end, epoch_ms(until)) if until else end
    if end <= begin:
        raise ValueError('empty scoring window')
    latest = {}
    observations = 0
    history = {}
    excluded = 0
    excluded_sources = 0
    canonical_socket = str(Path.home() / 'praesidium/var/run/praesidium/kernel.sock')
    missing_fields = set()
    with Path(shadow_log).open() as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                if not line.endswith('\n'):
                    break  # a live append may not have finished its last line
                raise
            source_data = row.get('data', {}) if 'event' in row else row
            if source_data.get('kernel_socket') != canonical_socket:
                excluded_sources += 1
                continue
            if 'event' in row:
                if row['event'] != 'shadow.decision':
                    data = row.get('data', {})
                    actor = data.get('actor') or data.get('principalRef')
                    # wrkq maintenance on envelope.show is not a shadow write.
                    if (row['event'] in ('envelope.expired', 'envelope.failed', 'envelope.undeliverable')
                            and actor == 'agent:mail-delivery'
                            and begin <= epoch_ms(row['ts']) < end):
                        excluded += 1
                    continue
                row = row['data']
            decided = epoch_ms(row['decided_at'])
            if not begin <= decided < end:
                continue
            _decision(row['decision'])
            _difference(row)
            epoch_ms(row['appeared_at'])
            observations += 1
            missing_fields.update(row.get('missing_fields', []))
            if row['decision'].get('missing_fact'):
                missing_fields.add(row['decision']['missing_fact'])
            identifier = row['envelope_id']
            if not isinstance(identifier, str) or not identifier:
                raise ValueError(f'line {line_number}: envelope_id must be a nonempty string')
            history.setdefault(identifier, []).append(row)
            if identifier not in latest or decided >= epoch_ms(latest[identifier]['decided_at']):
                latest[identifier] = row
    rows = []
    unmapped = set()
    connection = open_injector(injector_db)
    try:
        # A consistent snapshot across both tables, even while the injector writes.
        connection.execute('BEGIN')
        # Inventory all unmapped outcomes, including those absent from this fixture/log.
        outcomes = [row[0] for row in connection.execute('SELECT DISTINCT outcome FROM hrcmail_drive_diagnostics')]
        doors = [row[0] for row in connection.execute('SELECT DISTINCT door FROM hrcmail_delivery_intents')]
        for outcome in outcomes:
            if outcome not in ('admitted', 'seat_starting', 'seat_stopping', 'seat_unavailable',
                               'seat_turn-observed', 'broker_probe_failed'):
                unmapped.add(outcome)
        for door in doors:
            if _door(door) is None:
                unmapped.add('door:' + str(door))
        for identifier, shadow in sorted(latest.items()):
            decided = epoch_ms(shadow['decided_at'])
            appeared = epoch_ms(shadow['appeared_at'])
            action = shadow['decision']['action']
            intent, diagnostic, evidence = _evidence(connection, identifier, decided)
            result = comparison(shadow, intent, diagnostic, evidence, log_evidence)
            evidence = result.pop('evidence')
            actual = result['injector_decision']
            classification = result['classification']
            missing = result['missing_field']
            observation_scores = []
            ordered = sorted(history[identifier], key=lambda r: epoch_ms(r['decided_at']))
            for index, observation in enumerate(ordered):
                next_state = next((other.get('envelope_state_at') for other in ordered[index + 1:]
                    if other.get('envelope_state') != observation.get('envelope_state')), None)
                scored = comparison(observation, intent, diagnostic,
                    _evidence(connection, identifier, epoch_ms(observation['decided_at']))[2],
                    log_evidence, next_state)
                observation_scores.append(dict(decided_at=observation['decided_at'], **scored))
            if evidence is not None and actual is None:
                unmapped.add(evidence[3])
            acted = epoch_ms(evidence[0]) if evidence else None
            rows.append({
                'envelope_id': identifier, 'classification': classification, 'missing_field': missing,
                'cohort': 'new' if start <= datetime.fromisoformat(shadow['appeared_at'].replace('Z', '+00:00')) < start + timedelta(days=1) else 'backlog',
                'cannot_decide_kind': result['cannot_decide_kind'],
                'injector_log_evidence': result['injector_log_evidence'],
                'observation_scores': observation_scores,
                'shadow': shadow, 'shadow_history': history[identifier], 'injector_decision': actual,
                'injector_intent': intent, 'injector_diagnostic': diagnostic,
                'matched_source': evidence[2] if evidence else None,
                'injector_acted_at': evidence[0] if evidence else None,
                'matched_outside_day': not begin <= acted < end if acted is not None else None,
                'shadow_latency_ms': decided - appeared,
                'injector_latency_ms': acted - appeared if acted is not None else None,
                'latency_delta_ms': decided - acted if acted is not None else None,
                # One minute is the reminder hold, well below the 300 s insert
                # catch-up sweep. Flag timing, never infer a dropped insert.
                'shadow_well_before_injector': acted is not None and
                    acted - min(epoch_ms(r['decided_at']) for r in history[identifier]) >= 60_000,
                'log_fed_memos': sorted({name for r in history[identifier]
                                         for name in r.get('log_fed_memos', [])}),
                'broker_movement_dependent': any(r.get('broker_movement_dependent', False)
                                                  for r in history[identifier]),
            })
    finally:
        connection.close()
    return {
        'day': day, 'timezone': 'UTC', 'shadow_observations': observations,
        'envelopes': len(rows), 'counts': dict(sorted(Counter(r['classification'] for r in rows).items())),
        'counts_by_cohort': {cohort: dict(Counter(r['classification'] for r in rows if r['cohort'] == cohort))
                             for cohort in ('new', 'backlog')},
        'gate_cohort': 'new',
        'unmapped_outcomes': sorted(unmapped), 'observed_diagnostic_outcomes': sorted(outcomes),
        'observed_doors': sorted(doors),
        'since': since, 'until': until,
        'excluded_read_maintenance': excluded,
        'excluded_kernel_sources': excluded_sources,
        'kernel_socket': canonical_socket,
        'missing_fields': sorted(missing_fields),
        'early_injector_count': sum(r['shadow_well_before_injector'] for r in rows),
        'cannot_decide_counts': {kind: sum(r['cannot_decide_kind'] == kind for r in rows)
                                for kind in ('shadow_input_gap', 'injector_evidence_unmapped')},
        'cannot_decide_counts_by_cohort': {cohort: {
            kind: sum(r['cohort'] == cohort and r['cannot_decide_kind'] == kind for r in rows)
            for kind in ('shadow_input_gap', 'injector_evidence_unmapped')}
            for cohort in ('new', 'backlog')},
        'port_defect_count_by_cohort': {cohort: sum(r['cohort'] == cohort and
            (r['classification'] == 'differed_defect' or r['cannot_decide_kind'] == 'shadow_input_gap')
            for r in rows) for cohort in ('new', 'backlog')},
        'port_defect_count': sum(r['classification'] == 'differed_defect' or
                                  r['cannot_decide_kind'] == 'shadow_input_gap' for r in rows),
        'evidence_limit': ('State-aware rows require a state-transition time. Exact-envelope evidence is within 300 s; '
                          'target-only evidence within 30 s. Earlier admissions never score a current intent/reminder hold. '
                          'Unobserved injector decisions stay pending_evidence. DB tables retain latest rows, not history.'),
        'rows': rows,
    }


def write_report(report: dict, out: Path | str) -> tuple[Path, Path]:
    directory = Path(out)
    directory.mkdir(parents=True, exist_ok=True)
    json_path = directory / ('score-' + report['day'] + '.json')
    markdown_path = directory / ('score-' + report['day'] + '.md')
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    lines = [f"# Mail delivery shadow — {report['day']} (UTC)", '',
             f"{report['envelopes']} envelopes; {report['shadow_observations']} shadow observations.", '',
             'The gate uses envelopes created this UTC day; older backlog is shown separately.', '',
             '| Classification | New today | Older backlog | Total |', '| --- | ---: | ---: | ---: |']
    for category in ('agreed', 'differed_by_design', 'differed_missing_data', 'differed_defect', 'cannot_decide', 'pending_evidence'):
        lines.append(f"| {category} | {report['counts_by_cohort']['new'].get(category, 0)} | "
                     f"{report['counts_by_cohort']['backlog'].get(category, 0)} | {report['counts'].get(category, 0)} |")
    lines += ['', report['evidence_limit'], '',
              'cannot_decide: ' + ', '.join(f'{kind}={count}' for kind, count in report['cannot_decide_counts'].items()), '',
              f"Port defects (rule disagreements + shadow input gaps): {report['port_defect_count']}", '',
              'Missing inputs observed (including resolved): ' + (', '.join(report['missing_fields']) or 'none'), '',
              'cannot_decide split by cohort: ' + json.dumps(report['cannot_decide_counts_by_cohort'], sort_keys=True), '',
              f"Shadow at least 60 s before injector: {report['early_injector_count']}", '',
              f"Excluded read-triggered wrkq maintenance: {report['excluded_read_maintenance']}", '',
              f"Excluded noncanonical or unstamped kernel lines: {report['excluded_kernel_sources']}", '',
              'Timing: milliseconds from shadow appeared_at; delta = shadow minus injector.',
              'Design/missing-data classifications require explicit annotated evidence in the shadow log.', '',
              'Unmapped outcomes: ' + (', '.join(report['unmapped_outcomes']) or 'none'), '',
              '| Envelope | Class | Missing field | Shadow ms | Injector ms | Delta ms |',
              '| --- | --- | --- | ---: | ---: | ---: |']
    for row in report['rows']:
        values = [row['envelope_id'], row['classification'], row['missing_field'],
                  row['shadow_latency_ms'], row['injector_latency_ms'], row['latency_delta_ms']]
        lines.append('| ' + ' | '.join(str(v).replace('|', '\\|').replace('\n', ' ') if v is not None else '—' for v in values) + ' |')
    markdown_path.write_text('\n'.join(lines) + '\n')
    return markdown_path, json_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shadow-log', type=Path, default=Path.home() / 'praesidium/var/logs/agent-control-plane/mail-delivery.log')
    parser.add_argument('--injector-db', required=True, type=Path)
    parser.add_argument('--injector-log', type=Path,
                        default=Path.home() / 'praesidium/var/logs/hrc-runtime/hrc-mail-injector.log')
    parser.add_argument('--day', required=True)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--since', help='inclusive ISO UTC window start, e.g. first program start')
    parser.add_argument('--until', help='exclusive ISO UTC window end')
    args = parser.parse_args()
    for path in write_report(score(args.shadow_log, args.injector_db, args.day,
                                  since=args.since, until=args.until, injector_log=args.injector_log), args.out):
        print(path)


if __name__ == '__main__':
    main()
