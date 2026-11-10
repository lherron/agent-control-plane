"""Like-for-like injector inputs: short SQLite snapshots and existing HRC reads.

No diagnostics/previous injector door is used to choose a shadow door. Those
are comparison evidence only. Process-local outcome memos have their own log
feeder; their absence is never inferred from an empty document projection.
"""
from dataclasses import asdict, replace
import re
import time
from copy import deepcopy
from .decision import Decision, Envelope, Seat, Runtime, Intent, Presentation, Retry, Refusal, decide
from .hrc_read import HrcError
from .score import open_injector, epoch_ms
from . import timings as t


# hrc-core monitor/status-levels.ts TERMINAL_RUNTIME_STATUSES, same as the
# injector's isRuntimeUnavailableStatus (which additionally excludes detached).
TERMINAL = frozenset(('terminated', 'crashed', 'dead', 'stale', 'stopped', 'failed', 'disposed', 'exited'))
TURN_ENDS = ('turn.completed', 'turn.failed', 'turn.interrupted', 'turn.zombied', 'turn.reaped')


def ms(value):
    return epoch_ms(value) if value else None


def newest_receipt(receipts):
    # ledger/types.ts newestPresentationReceipt: missing/null/invalid dates
    # rank below dates, and the LAST receipt wins equal ranks.
    newest, newest_at = {}, float('-inf')
    for receipt in receipts:
        try:
            at = ms(receipt.get('presentedAt'))
        except (ValueError, TypeError):
            at = None
        rank = at if at is not None else float('-inf')
        if rank >= newest_at:
            newest, newest_at = receipt, rank
    return newest


def store_batch(path, mail):
    """Close the read transaction before ANY network read or host wait."""
    connection = open_injector(path)
    snapshots = {}
    try:
        connection.execute('BEGIN')
        for envelope in mail:
            identifier = envelope['id']
            target = envelope['to']['scopeRef'] + '/lane:main'
            def one(table, column, value):
                row = connection.execute(f'SELECT * FROM {table} WHERE {column}=?', (value,)).fetchone()
                return dict(row) if row else None
            def many(table, column, value):
                return [dict(row) for row in connection.execute(
                    f'SELECT * FROM {table} WHERE {column}=?', (value,))]
            snapshots[identifier] = dict(
                intent=one('hrcmail_delivery_intents', 'envelope_id', identifier),
                presentations=many('hrcmail_presentations', 'envelope_id', identifier),
                expiries=many('hrcmail_delivery_expiries', 'envelope_id', identifier),
                birth=one('hrcmail_birth_refusals', 'target_session_ref', target),
                launch=one('hrcmail_launch_failures', 'envelope_id', identifier),
                notices=many('hrcmail_failure_notices', 'target_session_ref', target),
                diagnostic=one('hrcmail_drive_diagnostics', 'envelope_id', identifier))
        return snapshots
    finally:
        connection.close()


def apply_memo_facts(envelope, seat, store, now, identifier, target, memos, tags):
    if memos.anchored:
        tags['log_fed_memos'].append('injector_outcomes')
        fallback = memos.fallback.get(envelope.id)
        backoff = memos.backoff.get(identifier)
        refusal = Refusal(kind=(fallback if envelope.id in memos.fallback else
                               'transient' if backoff else 'none'),
            attempts=backoff['attempts'] if backoff else 0,
            last_at=backoff['at'] if backoff else None)
        birth = memos.birth.get(target)
        retry = Retry(kind='none')
        if birth:
            retry = Retry(kind=birth['kind'], attempts=birth['attempts'], last_at=birth['at'],
                          host_reason=(birth['reason'] if birth['kind'] == 'participant_turn'
                                       else birth['reason'] or ''),
                          host_since=(store['launch'] or {}).get('participant_host_since_ms'))
        launch = store['launch']
        if launch:
            # failExhaustedLaunch precedes the seat door even if its
            # process-local pacing was reset on injector restart.
            since = launch.get('participant_host_since_ms')
            if since is not None and now - since >= t.PARTICIPANT_HOST_GIVE_UP_MS:
                retry = Retry(kind='launch', attempts=launch['attempts'], host_reason='host_absent',
                              host_since=launch['participant_host_since_ms'], last_at=None)
            elif since is None and launch['attempts'] >= 3:
                retry = Retry(kind='launch', attempts=launch['attempts'], host_reason='')
        envelope = replace(envelope, birth_retry=retry, steer_refusal=refusal)
        hold = memos.quiet.get(identifier)
        seat = replace(seat, steer_capability_refused=identifier in memos.capability,
            quiet_hold=bool(hold), quiet_since=hold['since'] if hold else None,
            quiet_moved=False if hold else None)
        tags['broker_movement_dependent'] = bool(hold)
    return envelope, seat



class PortInputs:
    def __init__(self, hrc, memos, read_owner=None, alive=lambda: None):
        self.hrc = hrc
        self.memos = memos
        self.read_owner = read_owner
        self.alive = alive
        self.cache = {}
        self.broker_cursors = {}
        self.retained_cache = {}
        self.cache_read_at = {}

    def retain(self):
        now = int(time.time() * 1000)
        for key, value in self.cache.items():
            self.retained_cache[key] = (self.cache_read_at.get(key, now), deepcopy(value))
        self.retained_cache = {k: v for k, v in self.retained_cache.items() if now-v[0] <= 900000}

    def begin(self):
        self.retain()
        self.cache.clear()
        self.cache_read_at.clear()

    def get(self, route, **params):
        self.alive()
        key = (route, tuple(sorted(params.items())))
        if key not in self.cache:
            self.cache[key] = self.hrc.get(route, **params)
            self.cache_read_at[key] = int(time.time()*1000)
        self.alive()
        return self.cache[key]

    def runtime(self, identifier):
        key = ('inspect', identifier)
        if key not in self.cache:
            self.alive()
            try:
                runtime = self.hrc.post('/v1/runtimes/inspect', runtimeId=identifier)
                # The injector's exact read calls parseHrcRuntimeStatus; a
                # null/missing status is malformed, not unknown_runtime.
                if runtime is None or not isinstance(runtime.get('status'), str):
                    raise ValueError('invalid inspected runtime status')
                self.cache[key] = runtime
            except HrcError as error:
                if error.payload.get('error', {}).get('code') != 'unknown_runtime':
                    raise
                self.cache[key] = None
        return self.cache[key]

    def target(self, scope, check_federation=True):
        location = self.get('/v1/federation/locate', scopeRef=scope)
        authority = location['authority']
        home = ('foreign' if authority.get('state') == 'bound' and not authority.get('isLocal')
                else 'local' if authority.get('state') == 'bound' else 'unbound')
        if home == 'foreign':
            return Seat(home=home), {}, {}
        try:
            target = self.get('/v1/targets/by-session-ref', sessionRef=scope + '/lane:main') or {}
        except HrcError as error:
            if error.payload.get('error', {}).get('code') != 'unknown_session':
                raise
            target = {}
        session = {}
        if target.get('activeHostSessionId'):
            session = self.get('/v1/sessions/by-host/' + target['activeHostSessionId'])
        runtime = {}
        observed = Seat(home=home, live_elsewhere=False, federation_complete=True,
                        session_exists=bool(session), state='absent')
        if session:
            key = ('runtimes', session['hostSessionId'])
            if key not in self.cache:
                self.alive()
                self.cache[key] = self.hrc.runtimes(hostSessionId=session['hostSessionId'], all='true')
                self.cache_read_at[key] = int(time.time()*1000)
            candidates = [r for r in self.cache[key]
                if r.get('generation') == session['generation'] and
                r.get('controllerKind') == 'harness-broker' and 'activeInvocationId' in r and
                r.get('status') not in TERMINAL and r.get('status') != 'detached']
            if candidates:
                runtime = candidates[-1]
                probe = self.get('/v1/runtimes/' + runtime['runtimeId'] + '/seat')
                state = probe['probe']['seat']['state'] if probe.get('probe') else 'unavailable'
                observed = replace(observed, state=state,
                    steer_capable='steer' in (probe.get('admissionClasses') or []),
                    awaiting_input=runtime.get('status') == 'awaiting_input')
                self.poll_broker(runtime, probe)
        # Like target-driver's launchHereOrSkip, inventory is a before-birth
        # guard. An existing intent or a nondue presentation is not a birth.
        if observed.state == 'absent' and check_federation:
            report = self.get('/v1/federation/runtimes', scope=scope)
            nodes = [node for node in report['nodes'] if node.get('state') == 'answered']
            live = [node['nodeId'] for node in nodes if any(
                r.get('scopeRef') == scope and r.get('status') not in TERMINAL and r.get('status') != 'detached'
                for r in node['runtimes'])]
            elsewhere = any(node != report['localNodeId'] for node in live) and report['localNodeId'] not in live
            if elsewhere:
                bindings = self.get('/v1/placement/bindings', home='self', state='active')
                elsewhere = not any(b.get('scopeRef') == scope and b.get('state') == 'active' and
                    b.get('homeNodeId') == report['localNodeId'] for b in bindings['bindings'])
            observed = replace(observed, live_elsewhere=elsewhere,
                               federation_complete=len(nodes) == len(report['nodes']))
        return observed, runtime, session

    def poll_broker(self, runtime, probe):
        invocation = probe.get('invocationId')
        if not invocation:
            return
        identifier = runtime['runtimeId']
        key = (identifier, invocation)
        hold = self.memos.quiet.get(identifier)
        # Only replay historical broker rows if a quiet hold needs them. Other
        # memos depend on the injector's outcomes, not these anonymous rows.
        after = self.broker_cursors.get(key,
            (hold.get('seq') or 0) if hold else (probe.get('currentBrokerSeq') or 0))
        rows = self.get('/v1/broker-events', runtimeId=identifier, invocationId=invocation,
                        generation=probe['generation'], afterSeq=after, follow='false')
        for row in rows:
            self.alive()
            self.memos.broker(identifier, row)
            self.broker_cursors[key] = max(self.broker_cursors.get(key, after), row['seq'])
        self.broker_cursors.setdefault(key, after)

    def terminal(self, identifier):
        events = []
        for kind in TURN_ENDS:
            events.extend(self.get('/v1/events/tail', runtimeId=identifier, eventKind=kind, limit=1)['events'])
        return max(events, key=lambda event: event['hrcSeq']) if events else None

    def gather(self, mail, detail, store, now):
        scope = mail['to']['scopeRef']
        target = scope + '/lane:main'
        tags = dict(log_fed_memos=[], broker_movement_dependent=False,
                    injector_anchor=self.memos.anchor)
        state = detail.get('state', mail['state'])
        if detail.get('terminal') or state in ('acked', 'failed', 'expired', 'withdrawn'):
            state = 'terminal'
        envelope = Envelope(id=mail['id'], obligation=detail.get('obligation', mail.get('obligation')), kind='envelope',
            state=state,
            delivery=detail.get('delivery'), created_at=ms(detail.get('createdAt', mail.get('createdAt'))),
            presented_before=len(detail['presentedTo']) > 0 if 'presentedTo' in detail else None,
            retry_at=ms(detail.get('retryAt')))
        seat, runtime, session = self.target(scope, check_federation=(
            state == 'pending' and store['intent'] is None))
        home_key = ('/v1/federation/locate', (('scopeRef', scope),))
        tags['home_read_at'] = self.cache_read_at.get(home_key)
        home_reply = self.cache.get(home_key) or {}
        tags['home_binding_changed_at'] = ms(((home_reply.get('authority') or {}).get('record') or {}).get('updatedAt'))
        context = Runtime(id=runtime.get('runtimeId'), status=runtime.get('status'),
                          created_at=ms(runtime.get('createdAt')))
        if seat.home == 'foreign' or seat.live_elsewhere:
            return envelope, seat, context, tags
        identifier = context.id
        intent = store['intent']
        if intent:
            normalized_intent = Intent(status='open', door='launch' if intent['door'] == 'invoke' else intent['door'],
                submitted_at=ms(intent['submitted_at']),
                landing='uncertain' if intent.get('uncertain_cause') else
                        'landed' if intent.get('last_evidence_kind') in ('input.accepted', 'submission.executed', 'submission.absorbed') else 'none',
                terminal_reason=intent.get('terminal_envelope_cause'), cleanup_done=bool(intent.get('cleanup_at')),
                has_runtime=bool(intent.get('runtime_id')), live_digest_siblings=None,
                scope_live=bool(runtime), prior_launch_failures=(store['launch'] or {}).get('attempts', 0))
        else:
            normalized_intent = Intent(status='none')
        expiries = store.get('expiries', [])
        strike = next((r['expiries'] for r in expiries if r['runtime_id'] == identifier), 0)
        envelope = replace(envelope, intent=normalized_intent, non_landing_strikes=strike)
        envelope, seat = apply_memo_facts(envelope, seat, store, now, identifier, target, self.memos, tags)
        task = re.search(r':task:(T-\d+)$', scope)
        seat = replace(seat, target_is_task=bool(task), task_read='not_applicable')
        if task and envelope.obligation == 'fyi' and seat.state == 'absent' and self.read_owner:
            result = self.read_owner('task.get', task=task[1])
            seat = replace(seat, task_read='ok' if result else 'failed', task_state=result.get('state'))
        if envelope.delivery == 'hold':
            self.alive()
            admission = self.hrc.post('/v1/submissions/preempt/admission', target=target,
                # Admission evaluates only target and origin, but its existing
                # submission DTO still requires a nonempty body. Never submit.
                body=detail.get('body') or mail['id'],
                origin=dict(detail.get('from', {}), envelopeId=mail['id']),
                ttlMs=t.KICKER_SUBMISSION_TTL_MS, turnPolicy='guarded')['admission']
            seat = replace(seat, preempt_admission=admission)
        if state == 'presented':
            receipts = detail.get('presentedTo', [])
            receipt = newest_receipt(receipts)
            receipt_runtime = receipt.get('runtimeId')
            presentation = next((p for p in store['presentations'] if p['runtime_id'] == receipt_runtime and
                (p.get('disposed_at') is None or p.get('disposition') == 'held:awaiting_operator')), None)
            if presentation:
                bound_runtime = runtime if identifier == receipt_runtime else self.runtime(receipt_runtime)
                terminal = self.terminal(receipt_runtime)
                p = Presentation(status='landed', runtime_matches=True,
                    runtime_live=bool(bound_runtime) and bound_runtime['status'] not in TERMINAL,
                    operator_held=presentation.get('disposition') == 'held:awaiting_operator',
                    landing_seq=presentation['landing_hrc_seq'], terminal_seq=terminal['hrcSeq'] if terminal else -1,
                    terminal_at=ms(terminal['ts']) if terminal else None,
                    reminder='landed' if presentation.get('reminder_landing_hrc_seq') is not None else
                             'armed' if presentation.get('reminder_armed_at') else 'none',
                    remind_at=ms(presentation.get('reminder_due_at')),
                    reminder_landing_seq=presentation.get('reminder_landing_hrc_seq'))
                envelope = replace(envelope, presentation=p)
            else:
                # A confirmed empty local table is not an unknown fact. The
                # injector has no due reminder and excludes this legacy mail.
                envelope = replace(envelope, presentation=Presentation(status='none'))
        return envelope, seat, context, tags

    def first_from_intent(self, mail, detail, store, admission, history, now):
        # Reuse ordinary envelope/store inputs and probes. Only a missing
        # home reply may make the existing locate GET; never preempt admission.
        self.retain()
        envelope = Envelope(id=mail['id'], obligation=detail.get('obligation', mail.get('obligation')),
            delivery=detail.get('delivery'), created_at=ms(detail.get('createdAt', mail.get('createdAt'))), kind='envelope')
        return self.first_delivery(mail, detail, store, envelope, Seat(), Runtime(), now,
            history=history, admission=admission, allow_home_read=True, allow_capability_read=True)

    def late_capability(self, identifier, scope, at, history, raw, raw_read_at, intent):
        """A later capability read needs proof of the same admitted invocation."""
        entry = history.as_of('runtime', identifier, at) if history is not None else None
        prior = entry['payload'] if entry else raw if raw_read_at is not None and raw_read_at <= at else {}
        generation = prior.get('generation')
        expected = prior.get('activeInvocationId')
        proof_source = 'runtime_history' if entry else 'ordinary_read'
        if expected is None and raw_read_at is not None and raw_read_at <= at:
            expected = raw.get('activeInvocationId')
            generation = generation if generation is not None else raw.get('generation')
            proof_source = 'ordinary_read'
        if generation is None and intent.get('runtime_id') == identifier and ms(intent.get('submitted_at')) == at:
            generation = intent.get('generation')
        if history is not None:
            current = history.rows['seat'].get(scope, [])
            if current and (current[-1]['payload'] or {}).get('activeRuntimeId') != identifier:
                return None, None, 'first_delivery.runtime_replaced'
        try:
            probe = self.get('/v1/runtimes/' + str(identifier) + '/seat')
        except HrcError as error:
            if error.status == 404 or error.payload.get('error', {}).get('code') in ('invalid_selector', 'invalid_fence'):
                return None, None, 'first_delivery.runtime_replaced'
            raise
        if probe.get('runtimeId') != identifier or (generation is not None and probe.get('generation') != generation):
            return None, None, 'first_delivery.runtime_replaced'
        if generation is None:
            return None, None, 'first_delivery.runtime_generation_at_admission'
        invocation = probe.get('invocationId')
        proof = dict(runtime_id=identifier, generation=generation, invocation_id=invocation,
                     source=proof_source, seq=None, time=None)
        if not invocation or (expected is not None and invocation != expected):
            return None, proof, 'first_delivery.invocation_at_admission'
        if expected is None:
            proof['source'] = 'broker_record'
            try:
                rows = self.get('/v1/broker-events', runtimeId=identifier, invocationId=invocation,
                    generation=generation, afterSeq=0, follow='false')
            except HrcError as error:
                proof['poll_error'] = dict(status=error.status, code=error.payload.get('error', {}).get('code'))
                return None, proof, 'first_delivery.invocation_at_admission'
            witness = next((r for r in rows if r.get('invocationId') == invocation and
                r.get('seq') is not None and ms(r.get('time')) is not None and ms(r['time']) < at), None)
            proof.update(records_returned=len(rows), first_record=(
                {key: rows[0].get(key) for key in ('seq', 'time', 'invocationId')} if rows else None))
            if witness is None:
                return None, proof, 'first_delivery.invocation_at_admission'
            proof.update(seq=witness['seq'], time=witness['time'])
        if not isinstance(probe.get('admissionClasses'), list):
            return None, proof, 'first_delivery.steer_capable'
        return 'steer' in probe['admissionClasses'], proof, None

    def first_delivery(self, mail, detail, store, envelope, seat, runtime, now, *, history=None, admission=None, allow_home_read=False, allow_capability_read=False):
        """Historical state with explicitly permitted home/capability GETs."""
        diagnostic = store.get('diagnostic')
        deliveries = self.memos.deliveries
        if admission is None:
            if not diagnostic or diagnostic.get('outcome') != 'admitted':
                return None
            admission = self.memos.deliveries.for_diagnostic(mail['id'], diagnostic.get('runtime_id'), diagnostic['created_at'])
        missing = []
        if admission is None:
            return dict(basis='reconstructed', at=diagnostic['created_at'], runtime_id=diagnostic.get('runtime_id'),
                capability_source='unavailable', capability_differed=False,
                decision=asdict(Decision('cannot_decide', 'reconstruction_missing',
                    missing_fact='first_delivery.matched_admission')), missing_fields=['first_delivery.matched_admission'])
        at = ms(admission['at'])
        data = admission['intent']['data']
        identifier = admission['runtime_id']
        joined_diagnostic = (deliveries.for_diagnostic(mail['id'], diagnostic.get('runtime_id'), diagnostic['created_at'])
            if diagnostic and diagnostic.get('outcome') == 'admitted' else None)
        matching_diagnostic = bool(joined_diagnostic and joined_diagnostic['at'] == admission['at'] and
            joined_diagnostic['admitted_at'] == admission['admitted_at'])
        state = diagnostic.get('observed_seat_state') if matching_diagnostic else data.get('observedSeatState')
        cache = {k:v[1] for k,v in self.retained_cache.items()} | self.cache
        raw = next((r for key, rows in cache.items() if key[0] == 'runtimes'
                    for r in rows if r.get('runtimeId') == identifier), {})
        raw_key = next((key for key, rows in cache.items() if key[0] == 'runtimes' and
                       any(r.get('runtimeId') == identifier for r in rows)), None)
        raw_read_at = self.cache_read_at.get(raw_key, (self.retained_cache.get(raw_key) or (None,))[0])
        probe = cache.get(('/v1/runtimes/' + str(identifier) + '/seat', ()), {})
        home_key = ('/v1/federation/locate', (('scopeRef', mail['to']['scopeRef']),))
        location = cache.get(home_key, {})
        authority = location.get('authority')
        if not authority and allow_home_read:
            # Same existing ordinary-gather GET; no extra route or probe.
            location = self.get('/v1/federation/locate', scopeRef=mail['to']['scopeRef'])
            authority = location['authority']
        authority = authority or {}
        read_at = self.cache_read_at.get(home_key, (self.retained_cache.get(home_key) or (None,))[0])
        home_source = ('cached_before_admission' if read_at is not None and read_at <= at else
                       'read_after_admission' if authority else 'unavailable')
        changed = ms((authority.get('record') or {}).get('updatedAt'))
        home_proven = changed <= at if changed is not None else None
        if not authority:
            missing.append('first_delivery.home_at_admission')
        memo = admission['memo']
        if not memo or not memo['anchored'] or envelope.created_at is None or ms(memo['anchor']) > envelope.created_at:
            missing.append('first_delivery.complete_memo_anchor')
        # A status carries an actual last-change time, unlike updatedAt/tool
        # activity. Never reuse a status that changed after the injector read.
        historical = {}
        status_lag = None
        absence_known = False
        if history is not None:
            seat_entry = history.as_of('seat', mail['to']['scopeRef'], at)
            runtime_entry = history.as_of('runtime', identifier, at)
            ready_at = history.ready_at['seat']
            absence_known = seat_entry is None and ready_at is not None and ready_at <= at
            historical = dict(seat=seat_entry, runtime=runtime_entry)
            if absence_known:
                state = 'absent'
            late = [entry for entry in history.rows['runtime'].get(identifier, [])
                if entry['payload'] is not None and entry['changed_field'] == 'statusChangedAt'
                and entry['changed_at'] is not None and entry['changed_at'] <= at < entry['received_at']
                and runtime_entry and entry['payload'].get('status') != runtime_entry['payload'].get('status')]
            if late:
                status_lag = max(entry['received_at']-entry['changed_at'] for entry in late)
                missing.append('first_delivery.runtime_watch_lag')
            if seat_entry is None and not absence_known:
                missing.append('history_cold')
            if runtime_entry is None and state != 'absent':
                runtime_ready = history.ready_at['runtime']
                if runtime_ready is None or runtime_ready > at:
                    if 'history_cold' not in missing:
                        missing.append('history_cold')
                else:
                    missing.append('first_delivery.runtime_history_before_admission')
            if seat_entry and state != 'absent' and seat_entry['payload'].get('activeRuntimeId') != identifier:
                missing.append('first_delivery.seat_runtime_history_mismatch')
            # Runtime state JSON remains from an existing probe, solely for
            # invocation proof. Status comes from the watch's as-of entry.
            raw = dict(raw, status=(runtime_entry['payload'].get('status') if runtime_entry else None))
            if runtime_entry and runtime_entry['payload'].get('createdAt'):
                raw['createdAt'] = runtime_entry['payload']['createdAt']
        else:
            status_at = ms(raw.get('statusChangedAt'))
            if state in ('idle', 'turn-active') and (status_at is None or status_at > at):
                missing.append('first_delivery.runtime_status_at_admission')
        logged_capability = data.get('steerCapable')
        own = None
        intent = store.get('intent') or {}
        invocation = probe.get('invocationId')
        diagnostics = (raw.get('runtimeStateJson') or {}).get('brokerDispatchDiagnostics') or {}
        witnesses = [diagnostics.get('liveSeatProbe') or {}] + (diagnostics.get('seatTransitions') or [])
        historical_probe = any(w.get('invocationId') == invocation and
            ms(w.get('observedAt') or w.get('transitionedAt')) is not None and
            ms(w.get('observedAt') or w.get('transitionedAt')) <= at for w in witnesses)
        matching_intent = (intent.get('runtime_id') == identifier and
                           intent.get('invocation_id') == invocation and ms(intent.get('submitted_at')) is not None and
                           ms(intent.get('submitted_at')) <= at)
        if invocation is not None and (matching_intent or historical_probe):
            own = 'steer' in (probe.get('admissionClasses') or [])
        capability_proof = None
        capability_gap = None
        late_probe = False
        if own is None and state in ('idle', 'turn-active') and allow_capability_read:
            own, capability_proof, capability_gap = self.late_capability(identifier, mail['to']['scopeRef'],
                at, history, raw, raw_read_at, intent)
            late_probe = own is not None
        source = 'port_probe' if own is not None else 'injector_log' if isinstance(logged_capability, bool) else 'unavailable'
        if late_probe:
            source = 'port_probe_after_admission'
        capable = own if own is not None else logged_capability if isinstance(logged_capability, bool) else None
        if state not in ('idle', 'turn-active'):
            source = 'not_needed'
        elif capable is None:
            missing.append(capability_gap or 'first_delivery.steer_capable')
        if state == 'absent' and not absence_known and 'history_cold' not in missing:
            missing.append('first_delivery.session_exists_at_admission')
        form = data.get('form')
        if form not in ('full', 'defer-retry', 'digest'):
            missing.append('first_delivery.prior_presentations')
        # No prior intent after a complete anchor proves zero pre-first-attempt
        # strikes. Otherwise a later successful landing may have cleared them.
        first = deliveries.first_intent(mail['id'])
        first_attempt = first is admission['intent']
        expiries = [r for r in store.get('expiries', []) if r.get('runtime_id') == identifier]
        strikes = 0 if first_attempt and memo and memo['anchored'] and envelope.created_at is not None and ms(memo['anchor']) <= envelope.created_at else None
        if expiries:
            row = expiries[0]
            expired_at = ms(row.get('last_expired_at'))
            if expired_at is None or expired_at > at:
                missing.append('first_delivery.non_landing_strikes_at_admission')
            else:
                strikes = row['expiries']
        elif not first_attempt:
            missing.append('first_delivery.non_landing_strikes_at_admission')
        if store.get('launch'):
            missing.append('first_delivery.launch_failures_at_admission')
        if envelope.delivery == 'hold' and not absence_known and form != 'digest':
            missing.append('first_delivery.preempt_admission_at_admission')
        reconstructed = replace(envelope, state='pending', presented_before=form != 'full',
            intent=Intent(status='none'), presentation=Presentation(status='none'), non_landing_strikes=strikes)
        home = ('foreign' if authority.get('state') == 'bound' and not authority.get('isLocal') else
                'local' if authority.get('state') == 'bound' else 'unbound' if authority else seat.home)
        observed = replace(seat, home=home,
            live_elsewhere=False if home in ('local', 'unbound') else seat.live_elsewhere,
            federation_complete=True if home in ('local', 'unbound') else seat.federation_complete,
            state=state, session_exists=False if absence_known else True if state != 'absent' else None,
            steer_capable=capable, awaiting_input=(raw['status'] == 'awaiting_input' if raw.get('status') is not None else None))
        context = Runtime(id=None if absence_known else identifier, status=raw.get('status'),
            created_at=None if absence_known else ms(raw.get('createdAt')))
        if memo:
            from types import SimpleNamespace
            reconstructed, observed = apply_memo_facts(reconstructed, observed,
                dict(store, intent=None, presentations=[], launch=None), at, identifier,
                mail['to']['scopeRef']+'/lane:main', SimpleNamespace(**memo), {'log_fed_memos': []})
        decision = (Decision('cannot_decide', 'reconstruction_missing', missing_fact=missing[0]) if missing else
                    decide(reconstructed, observed, context, at))
        if decision.missing_fact and decision.missing_fact not in missing:
            missing.append(decision.missing_fact)
        # Keep the histories themselves in memory only; log just the input
        # facts/clocks used, never whole watch payloads or previews.
        historical = {kind: (dict(received_at=entry['received_at'], changed_at=entry['changed_at'],
            changed_field=entry['changed_field'], status=entry['payload'].get('status'),
            active_runtime_id=entry['payload'].get('activeRuntimeId')) if entry else None)
            for kind, entry in historical.items()}
        return dict(basis='reconstructed', at=admission['at'], runtime_id=identifier,
            diagnostic_at=diagnostic['created_at'] if matching_diagnostic else None, admitted_at=admission['admitted_at'],
            history=historical, history_status_lag_ms=status_lag,
            seat_watch_ready_at=history.ready_at['seat'] if history is not None else None,
            seat_state_source='watch_absence' if absence_known else 'injector_diagnostic' if matching_diagnostic else 'injector_intent',
            home_source=home_source, home_read_at=read_at, home_binding_predates_admission=home_proven,
            home_binding_changed_at=changed,
            capability_source=source, port_capability=own, injector_capability=logged_capability,
            capability_proof=capability_proof,
            capability_differed=own is not None and isinstance(logged_capability, bool) and own != logged_capability,
            decision=asdict(decision), missing_fields=missing,
            inputs=dict(envelope=asdict(reconstructed), seat=asdict(observed), runtime=asdict(context)))
