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


def _diagnostic(diagnostic, intent, logged_admission=None):
    outcome = diagnostic['outcome']
    # Observed on max3: admitted, seat_starting, seat_turn-observed, seat_unavailable.
    # Other deferred paths are explicit recordDeferredDiagnostic calls in target-driver.ts.
    if outcome in ('seat_starting', 'seat_stopping', 'seat_unavailable',
                   'seat_turn-observed', 'broker_probe_failed'):
        return 'defer'
    if outcome == 'admitted' and logged_admission is not None:
        return logged_admission['door']
    if outcome == 'admitted' and intent is not None:
        # 'admitted' says no door. A stale intent from another runtime cannot supply it.
        if diagnostic['runtime_id'] == intent['runtime_id'] and epoch_ms(intent['submitted_at']) <= epoch_ms(diagnostic['created_at']):
            return _door(intent['door'])
    # Hold/skip are currently target completion LOGS, not rows in this table.
    return None


def _evidence(c, envelope_id, decided_at, log_evidence=None):
    intent_row = c.execute('''SELECT envelope_id, door, runtime_id, generation,
        delivery_outcome, submitted_at FROM hrcmail_delivery_intents WHERE envelope_id=?''',
        (envelope_id,)).fetchone()
    diagnostic_row = c.execute('''SELECT envelope_id, target_session_ref, wake_reason,
        outcome, observed_seat_state, runtime_id, created_at
        FROM hrcmail_drive_diagnostics WHERE envelope_id=?''', (envelope_id,)).fetchone()
    intent = dict(intent_row) if intent_row else None
    diagnostic = dict(diagnostic_row) if diagnostic_row else None
    logged_admission = (log_evidence.deliveries.for_diagnostic(envelope_id, diagnostic['runtime_id'], diagnostic['created_at'])
                        if log_evidence and diagnostic else None)
    candidates = []
    if intent is not None:
        candidates.append((intent['submitted_at'], _door(intent['door']), 'intent', intent['door']))
    if diagnostic is not None:
        candidates.append((diagnostic['created_at'], _diagnostic(diagnostic, intent, logged_admission),
                           'diagnostic', diagnostic['outcome']))
    if not candidates:
        return intent, diagnostic, None
    # Compare the observation closest to this shadow decision. Both original rows
    # remain in the report, including an unknown closer diagnostic (never hidden).
    selected = min(candidates, key=lambda x: (abs(epoch_ms(x[0]) - decided_at), x[2]))
    return intent, diagnostic, selected


def comparison(shadow, intent, diagnostic, legacy_evidence, log_evidence, state_until=None, *, cutoff=None, observation_until=None):
    evidence = legacy_evidence
    records = []
    if 'envelope_state' in shadow:
        candidates = []
        if intent:
            candidates.append((intent['submitted_at'], _door(intent['door']), 'intent', intent['door']))
        if diagnostic:
            admission = log_evidence.deliveries.for_diagnostic(shadow['envelope_id'], diagnostic['runtime_id'], diagnostic['created_at'])
            candidates.append((diagnostic['created_at'], _diagnostic(diagnostic, intent, admission),
                               'diagnostic', diagnostic['outcome']))
        selected = log_evidence.match(shadow, candidates, state_until)
        evidence = ((selected['at'], selected['action'], selected['source'], selected['label'])
                    if selected else None)
        records = selected['records'] if selected else []
    landed = log_evidence.deliveries.landed_before(shadow)
    if landed is not None:
        return dict(classification='differed_defect', cannot_decide_kind=None,
            missing_field=None, cause='stale_pending_after_delivery',
            evidence=[landed['ts'], 'hold', 'injector_log', landed['event']],
            injector_log_evidence=[landed], injector_decision='hold')
    action = shadow['decision']['action']
    cause = None
    if 'envelope_state' in shadow and action in ('steer', 'enqueue', 'launch', 'preempt', 'hold', 'defer'):
        decided = epoch_ms(shadow['decided_at'])
        deadline = decided + 300000
        nonact = action in ('hold', 'defer')
        for boundary in (state_until, observation_until if nonact else None):
            if boundary:
                deadline = min(deadline, epoch_ms(boundary))
        retry = shadow['decision'].get('retry_at')
        if nonact and retry is not None and retry > decided:
            deadline = min(deadline, retry)
        presented = [epoch_ms(r['ts']) for r in log_evidence.deliveries.presented.get(shadow['envelope_id'], [])
                     if epoch_ms(r['ts']) > decided]
        if presented:
            deadline = min(deadline, min(presented))
        lower = decided if nonact else epoch_ms(shadow.get('envelope_state_at') or shadow['decided_at'])
        acts = [r['row'] for r in log_evidence.deliveries.intents.get(shadow['envelope_id'], [])
                if lower <= epoch_ms(r['row']['ts']) < min(deadline, cutoff if cutoff is not None else float('inf'))
                and abs(epoch_ms(r['row']['ts']) - decided) <= 300000
                and (shadow['envelope_state'] == 'pending' or r['row']['data'].get('form') == 'reminder')]
        if evidence and epoch_ms(evidence[0]) >= min(deadline, cutoff if cutoff is not None else float('inf')):
            evidence, records = None, []
        if acts:
            chosen = min(acts, key=lambda r: abs(epoch_ms(r['ts']) - decided))
            evidence = (chosen['ts'], _door(chosen['data'].get('door')), 'injector_log', chosen['event'])
            records = [chosen]
        elif nonact and evidence and evidence[1] in ('steer', 'enqueue', 'launch', 'preempt'):
            evidence, records = None, []  # completion of an intent opened before this fence
        if evidence is None or (not nonact and evidence[1] not in ('steer', 'enqueue', 'launch', 'preempt')):
            closed = cutoff is None or cutoff >= deadline
            classification = ('agreed_by_inaction' if nonact else 'differed_defect') if closed else 'pending_evidence'
            cause = ('no_injector_act' if closed else 'evidence_window_open')
            return dict(classification=classification, cannot_decide_kind=None, missing_field=None,
                cause=cause, evidence_window_end_ms=deadline, evidence=None,
                injector_log_evidence=[], injector_decision=None)
    actual = evidence[1] if evidence else None
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


def first_delivery_comparison(identifier, observations, deliveries, required=False):
    intent = deliveries.first_intent(identifier)
    admission = deliveries.first_admission(identifier)
    snapshots = [r['first_delivery'] for r in observations if r.get('first_delivery')]
    snapshot = next(iter(snapshots), None)
    if snapshot is None and intent is not None:
        boundary = admission['admitted_at'] if admission else intent['ts']
        observed = next((r for r in observations if r['decision']['action'] in ('steer', 'enqueue', 'launch', 'preempt')
                         and epoch_ms(r['decided_at']) <= epoch_ms(boundary)), None)
        if observed:
            snapshot = dict(basis='observed_before_injector', at=observed['decided_at'],
                runtime_id=observed.get('runtime_id'), decision=observed['decision'],
                capability_source='port_probe' if observed.get('observed_seat_state') in ('idle', 'turn-active') else 'not_needed')
    if not required and snapshot is None:
        return None
    base = dict(comparison_kind='first_delivery', decided_at=snapshot['at'] if snapshot else observations[0]['decided_at'],
        basis=snapshot.get('basis') if snapshot else 'missing', capability_source=snapshot.get('capability_source', 'unavailable') if snapshot else 'unavailable',
        capability_differed=False, missing_field=None, cannot_decide_kind=None, evidence=None,
        injector_log_evidence=[], injector_decision=None, shadow_snapshot=snapshot)
    if intent is None:
        return dict(base, classification='cannot_decide', cannot_decide_kind='injector_evidence_unmapped',
                    missing_field='injector.first_delivery_door')
    if snapshot is None:
        return dict(base, classification='cannot_decide', cannot_decide_kind='shadow_input_gap',
                    missing_field='first_delivery.snapshot_missing')
    reconstructed = snapshot.get('basis') == 'reconstructed'
    chosen = admission['intent'] if reconstructed and admission else intent
    if reconstructed and (admission is None or snapshot.get('runtime_id') != admission['runtime_id']
                          or snapshot['at'] != admission['at']):
        return dict(base, classification='cannot_decide', cannot_decide_kind='injector_evidence_unmapped',
                    missing_field='injector.matched_admission')
    boundary = admission['admitted_at'] if admission else intent['ts']
    if not reconstructed and epoch_ms(snapshot['at']) > epoch_ms(boundary):
        return dict(base, classification='cannot_decide', cannot_decide_kind='shadow_input_gap',
                    missing_field='first_delivery.snapshot_missing')
    actual = _door(chosen['data'].get('door'))
    decision = snapshot['decision']
    own = snapshot.get('port_capability')
    logged = chosen['data'].get('steerCapable')
    capability_differed = snapshot.get('capability_differed', False) or (
        isinstance(own, bool) and isinstance(logged, bool) and own != logged)
    base.update(injector_decision=actual, evidence=[chosen['ts'], actual, 'injector_log', chosen['event']],
        injector_log_evidence=admission['records'] if reconstructed and admission else [chosen],
        capability_differed=capability_differed, decision=decision,
        shadow_door=snapshot.get('door', decision['action'] if decision['action'] in ('steer', 'enqueue', 'launch', 'preempt') else None),
        injector_raw_door=chosen['data'].get('door'))
    if capability_differed:
        return dict(base, classification='differed_defect', cause='capability_derivation_differed')
    if decision['action'] == 'cannot_decide':
        return dict(base, classification='cannot_decide', cannot_decide_kind='shadow_input_gap',
                    missing_field=decision['missing_fact'])
    if actual is None:
        return dict(base, classification='cannot_decide', cannot_decide_kind='injector_evidence_unmapped',
                    missing_field='injector.first_delivery_door')
    return dict(base, classification='agreed' if decision['action'] == actual and base['shadow_door'] == actual else 'differed_defect')


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
    failures = []
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
                if row['event'] == 'shadow.decision_failed':
                    if begin <= epoch_ms(row['ts']) < end:
                        data = dict(row['data'], ts=row['ts'])
                        appeared = data.get('appeared_at')
                        data['cohort'] = ('new' if appeared[:10] == day else 'backlog') if appeared else 'unknown'
                        failures.append(data)
                    continue
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
            observation_scores = []
            ordered = sorted(history[identifier], key=lambda r: epoch_ms(r['decided_at']))
            for index, observation in enumerate(ordered):
                next_state = next((other.get('envelope_state_at') for other in ordered[index + 1:]
                    if other.get('envelope_state') != observation.get('envelope_state')), None)
                scored = comparison(observation, intent, diagnostic,
                    _evidence(connection, identifier, epoch_ms(observation['decided_at']), log_evidence)[2],
                    log_evidence, next_state, cutoff=end,
                    observation_until=ordered[index + 1]['decided_at'] if index + 1 < len(ordered) else None)
                observation_scores.append(dict(decided_at=observation['decided_at'],
                    decision=observation['decision'], **scored))
            cohort = 'new' if start <= datetime.fromisoformat(shadow['appeared_at'].replace('Z', '+00:00')) < start + timedelta(days=1) else 'backlog'
            first = first_delivery_comparison(identifier, ordered, log_evidence.deliveries,
                required=cohort == 'new' and identifier in log_evidence.deliveries.delivered_envelopes())
            if first is not None:
                observation_scores.append(first)
                if first.get('missing_field'):
                    missing_fields.add(first['missing_field'])
                for value in (first.get('shadow_snapshot') or {}).get('missing_fields', []):
                    missing_fields.add(value)
            priority = {'differed_defect': 0, 'cannot_decide': 1, 'differed_missing_data': 1,
                        'differed_by_design': 2, 'pending_evidence': 3, 'agreed': 4, 'agreed_by_inaction': 5}
            result = min(observation_scores, key=lambda r: (priority[r['classification']], epoch_ms(r['decided_at'])))
            evidence = result['evidence']
            actual = result['injector_decision']
            classification = result['classification']
            if 'envelope_state' in shadow and classification in ('agreed', 'agreed_by_inaction'):
                door_agreed = (first is not None and first['classification'] == 'agreed') or any(
                    o['classification'] == 'agreed' and o.get('decision', {}).get('action') in ('steer', 'enqueue', 'launch', 'preempt')
                    for o in observation_scores)
                if door_agreed:
                    classification = 'agreed'
                else:
                    result = dict(result, classification='cannot_decide', cannot_decide_kind='injector_evidence_unmapped',
                        missing_field='first_delivery.historical_comparison_missing', cause='inaction_only_no_door_comparison')
                    classification = 'cannot_decide'
                    missing_fields.add(result['missing_field'])
            missing = result['missing_field']
            if evidence is not None and actual is None:
                unmapped.add(evidence[3])
            acted = epoch_ms(evidence[0]) if evidence else None
            rows.append({
                'envelope_id': identifier, 'classification': classification, 'missing_field': missing,
                'cohort': cohort,
                'first_delivery_comparison': first,
                'injector_delivered': identifier in log_evidence.deliveries.delivered_envelopes(),
                'cannot_decide_kind': result['cannot_decide_kind'],
                'injector_log_evidence': result['injector_log_evidence'],
                'observation_scores': observation_scores,
                'classifying_observation': result,
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
    new_rows = [r for r in rows if r['cohort'] == 'new']
    compared = [r for r in new_rows if r['first_delivery_comparison'] and
                r['first_delivery_comparison']['classification'] in ('agreed', 'differed_defect')]
    uncompared = [dict(envelope_id=r['envelope_id'], classification=r['classification'],
        cause=r['missing_field'] or (r['classifying_observation'].get('cause', 'evidence_window_open') if r['classification'] == 'pending_evidence' else 'first_delivery.not_compared'))
        for r in new_rows if r['classification'] in ('cannot_decide', 'pending_evidence')]
    gate = dict(new_envelopes=len(new_rows),
        new_injector_delivered=sum(r['injector_delivered'] for r in new_rows),
        new_compared_and_agreed=sum(r['injector_delivered'] and r['first_delivery_comparison'] is not None and
            r['first_delivery_comparison']['classification'] == 'agreed' for r in new_rows),
        new_first_delivery_compared=len(compared),
        first_delivery_uncompared=[dict(envelope_id=r['envelope_id'], cause=(r['first_delivery_comparison'] or {}).get('missing_field') or 'first_delivery.not_compared')
            for r in new_rows if r['injector_delivered'] and (not r['first_delivery_comparison'] or r['first_delivery_comparison']['classification'] == 'cannot_decide')],
        new_uncompared=len(uncompared),
        new_uncompared_share=len(uncompared)/len(new_rows) if new_rows else 0.0,
        uncompared=uncompared, capability_sources=dict(Counter(r['first_delivery_comparison']['capability_source'] for r in compared)),
        capability_differences=[r['envelope_id'] for r in rows if r['first_delivery_comparison'] and
            r['first_delivery_comparison'].get('capability_differed')])
    return {
        'gate': gate,
        'agreed_by_inaction_observations': sum(o['classification'] == 'agreed_by_inaction' for r in rows for o in r['observation_scores']),
        'compared_agreement_observations': sum(o['classification'] == 'agreed' for r in rows for o in r['observation_scores'] if o.get('comparison_kind') != 'first_delivery'),
        'first_delivery_field_observations': sum(bool(r.get('first_delivery')) for records in history.values() for r in records),
        'day': day, 'timezone': 'UTC', 'shadow_observations': observations,
        'envelopes': len(rows), 'counts': dict(sorted(Counter(r['classification'] for r in rows).items())),
        'counts_by_cohort': {cohort: dict(Counter(r['classification'] for r in rows if r['cohort'] == cohort))
                             for cohort in ('new', 'backlog')},
        'gate_cohort': 'new',
        'decision_failed_count': len(failures),
        'decision_failed_envelopes': sorted({f['envelope_id'] for f in failures}),
        'decision_failed_counts_by_cohort': {cohort: sum(f['cohort'] == cohort for f in failures)
                                             for cohort in ('new', 'backlog', 'unknown')},
        'decision_failures': failures,
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
                          'Closed windows with no injector act agree by inaction for hold/defer and are defects for acts. '
                          'Only open windows remain pending_evidence. DB tables retain latest rows, not history.'),
        'rows': rows,
    }


def write_report(report: dict, out: Path | str) -> tuple[Path, Path]:
    directory = Path(out)
    directory.mkdir(parents=True, exist_ok=True)
    json_path = directory / ('score-' + report['day'] + '.json')
    markdown_path = directory / ('score-' + report['day'] + '.md')
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    gate = report['gate']
    lines = [f"# Mail delivery shadow — {report['day']} (UTC)", '',
             f"New injector-delivered: {gate['new_injector_delivered']}; compared and agreed: {gate['new_compared_and_agreed']}.", '',
             f"New left uncompared: {gate['new_uncompared']}/{gate['new_envelopes']} ({gate['new_uncompared_share']:.1%}).", '',
             'Compared capability sources: ' + json.dumps(gate['capability_sources'], sort_keys=True), '',
             'Capability derivation differences: ' + (', '.join(gate['capability_differences']) or 'none'), '',
             f"First-delivery fields recorded in this log window: {report['first_delivery_field_observations']}.", '',

             f"Inaction agreements: {report['agreed_by_inaction_observations']} observations; compared observation agreements: {report['compared_agreement_observations']} (first delivery counted separately above).", '',
             f"{report['envelopes']} envelopes; {report['shadow_observations']} shadow observations.", '',
             'The gate uses envelopes created this UTC day; older backlog is shown separately.', '',
             '| Classification | New today | Older backlog | Total |', '| --- | ---: | ---: | ---: |']
    for category in ('agreed', 'differed_by_design', 'differed_missing_data', 'differed_defect', 'cannot_decide', 'pending_evidence'):
        lines.append(f"| {category} | {report['counts_by_cohort']['new'].get(category, 0)} | "
                     f"{report['counts_by_cohort']['backlog'].get(category, 0)} | {report['counts'].get(category, 0)} |")
    lines += ['', f"decision_failed: {report['decision_failed_count']} lines (separate failure bucket, never agreement).", '',
              'Failed envelopes: ' + (', '.join(report['decision_failed_envelopes']) or 'none'), '',
              'Failure lines by cohort: ' + json.dumps(report['decision_failed_counts_by_cohort'], sort_keys=True), '',
              report['evidence_limit'], '',
              'cannot_decide: ' + ', '.join(f'{kind}={count}' for kind, count in report['cannot_decide_counts'].items()), '',
              f"Port defects (rule disagreements + shadow input gaps): {report['port_defect_count']}", '',
              'Missing inputs observed (including resolved): ' + (', '.join(report['missing_fields']) or 'none'), '',
              'cannot_decide split by cohort: ' + json.dumps(report['cannot_decide_counts_by_cohort'], sort_keys=True), '',
              f"Shadow at least 60 s before injector: {report['early_injector_count']}", '',
              f"Excluded read-triggered wrkq maintenance: {report['excluded_read_maintenance']}", '',
              f"Excluded noncanonical or unstamped kernel lines: {report['excluded_kernel_sources']}", '',
              'Uncompared new envelopes and causes: ' + json.dumps(gate['uncompared'], sort_keys=True), '',
              'First-delivery coverage gaps (including envelopes classed as defects): ' + json.dumps(gate['first_delivery_uncompared'], sort_keys=True), '',
              'Pending evidence causes: ' + json.dumps([dict(envelope_id=r['envelope_id'], cause=r['classifying_observation'].get('cause')) for r in report['rows'] if r['classification'] == 'pending_evidence']), '',
              'Timing: milliseconds from shadow appeared_at; delta = shadow minus injector.',
              'Design/missing-data classifications require explicit annotated evidence in the shadow log.', '',
              'Unmapped outcomes: ' + (', '.join(report['unmapped_outcomes']) or 'none'), '',
              '| Envelope | Class | Classifying observation | Missing field | Shadow ms | Injector ms | Delta ms |',
              '| --- | --- | --- | --- | ---: | ---: | ---: |']
    for row in report['rows']:
        values = [row['envelope_id'], row['classification'], row['classifying_observation']['decided_at'], row['missing_field'],
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
