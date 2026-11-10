"""Daily read-only comparison against the injector's *latest* per-envelope rows.

This is an operator tool, not a service entry point. All DB connections use
mode=ro and query_only. The shadow log supplies the envelope appearance time;
this store cannot recover it or historical decisions overwritten by upserts.
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


def score(shadow_log: Path | str, injector_db: Path | str, day: str) -> dict:
    start = datetime.combine(date.fromisoformat(day), datetime.min.time(), timezone.utc)
    begin = int(start.timestamp() * 1000)
    end = int((start + timedelta(days=1)).timestamp() * 1000)
    latest = {}
    observations = 0
    history = {}
    with Path(shadow_log).open() as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            decided = epoch_ms(row['decided_at'])
            if not begin <= decided < end:
                continue
            _decision(row['decision'])
            _difference(row)
            epoch_ms(row['appeared_at'])
            observations += 1
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
            actual = evidence[1] if evidence else None
            missing = None
            difference = shadow.get('difference')
            if action == 'cannot_decide':
                classification = 'cannot_decide'
                missing = shadow['decision']['missing_fact']
            elif actual is None:
                classification = 'cannot_decide'
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
            if evidence is not None and actual is None:
                unmapped.add(evidence[3])
            acted = epoch_ms(evidence[0]) if evidence else None
            rows.append({
                'envelope_id': identifier, 'classification': classification, 'missing_field': missing,
                'shadow': shadow, 'shadow_history': history[identifier], 'injector_decision': actual,
                'injector_intent': intent, 'injector_diagnostic': diagnostic,
                'matched_source': evidence[2] if evidence else None,
                'injector_acted_at': evidence[0] if evidence else None,
                'matched_outside_day': not begin <= acted < end if acted is not None else None,
                'shadow_latency_ms': decided - appeared,
                'injector_latency_ms': acted - appeared if acted is not None else None,
                'latency_delta_ms': decided - acted if acted is not None else None,
            })
    finally:
        connection.close()
    return {
        'day': day, 'timezone': 'UTC', 'shadow_observations': observations,
        'envelopes': len(rows), 'counts': dict(sorted(Counter(r['classification'] for r in rows).items())),
        'unmapped_outcomes': sorted(unmapped), 'observed_diagnostic_outcomes': sorted(outcomes),
        'observed_doors': sorted(doors),
        'evidence_limit': 'Latest row per envelope only; closest timestamp selected. Not an injector history.',
        'rows': rows,
    }


def write_report(report: dict, out: Path | str) -> tuple[Path, Path]:
    directory = Path(out)
    directory.mkdir(parents=True, exist_ok=True)
    json_path = directory / (report['day'] + '.json')
    markdown_path = directory / (report['day'] + '.md')
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    lines = [f"# Mail delivery shadow — {report['day']} (UTC)", '',
             f"{report['envelopes']} envelopes; {report['shadow_observations']} shadow observations.", '',
             '| Classification | Envelopes |', '| --- | ---: |']
    for category in ('agreed', 'differed_by_design', 'differed_missing_data', 'differed_defect', 'cannot_decide'):
        lines.append(f"| {category} | {report['counts'].get(category, 0)} |")
    lines += ['', report['evidence_limit'], '',
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
    parser.add_argument('--shadow-log', required=True, type=Path)
    parser.add_argument('--injector-db', required=True, type=Path)
    parser.add_argument('--day', required=True)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    for path in write_report(score(args.shadow_log, args.injector_db, args.day), args.out):
        print(path)


if __name__ == '__main__':
    main()
