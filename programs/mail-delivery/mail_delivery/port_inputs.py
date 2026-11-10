"""Like-for-like injector inputs: short SQLite snapshots and existing HRC reads.

No diagnostics/previous injector door is used to choose a shadow door. Those
are comparison evidence only. Process-local outcome memos have their own log
feeder; their absence is never inferred from an empty document projection.
"""
from dataclasses import replace
import re
from .decision import Envelope, Seat, Runtime, Intent, Presentation, Retry, Refusal
from .hrc_read import HrcError
from .score import open_injector, epoch_ms
from . import timings as t


# hrc-core monitor/status-levels.ts TERMINAL_RUNTIME_STATUSES, same as the
# injector's isRuntimeUnavailableStatus (which additionally excludes detached).
TERMINAL = frozenset(('terminated', 'crashed', 'dead', 'stale', 'stopped', 'failed', 'disposed', 'exited'))
TURN_ENDS = ('turn.completed', 'turn.failed', 'turn.interrupted', 'turn.zombied', 'turn.reaped')


def ms(value):
    return epoch_ms(value) if value else None


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
                notices=many('hrcmail_failure_notices', 'target_session_ref', target))
        return snapshots
    finally:
        connection.close()


class PortInputs:
    def __init__(self, hrc, memos, read_owner=None, alive=lambda: None):
        self.hrc = hrc
        self.memos = memos
        self.read_owner = read_owner
        self.alive = alive
        self.cache = {}
        self.broker_cursors = {}

    def begin(self):
        self.cache.clear()

    def get(self, route, **params):
        self.alive()
        key = (route, tuple(sorted(params.items())))
        if key not in self.cache:
            self.cache[key] = self.hrc.get(route, **params)
        self.alive()
        return self.cache[key]

    def runtime(self, identifier):
        key = ('inspect', identifier)
        if key not in self.cache:
            self.alive()
            try:
                self.cache[key] = self.hrc.post('/v1/runtimes/inspect', runtimeId=identifier)
            except HrcError as error:
                if error.payload.get('error', {}).get('code') != 'unknown_runtime':
                    raise
                self.cache[key] = None
        return self.cache[key]

    def target(self, scope, check_federation=True):
        location = self.get('/v1/federation/locate', scopeRef=scope)
        authority = location['authority']
        home = ('foreign' if authority['state'] == 'bound' and not authority['isLocal']
                else 'local' if authority['state'] == 'bound' else 'unbound')
        if home == 'foreign':
            return Seat(home=home), {}, {}
        try:
            target = self.get('/v1/targets/by-session-ref', sessionRef=scope + '/lane:main')
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
            candidates = [r for r in self.cache[key]
                if r.get('generation') == session['generation'] and
                r.get('controllerKind') == 'harness-broker' and r.get('activeInvocationId') and
                r['status'] not in TERMINAL and r['status'] != 'detached']
            if candidates:
                runtime = candidates[-1]
                probe = self.get('/v1/runtimes/' + runtime['runtimeId'] + '/seat')
                state = probe['probe']['seat']['state'] if probe.get('probe') else 'unavailable'
                observed = replace(observed, state=state,
                    steer_capable='steer' in probe.get('admissionClasses', []),
                    awaiting_input=runtime['status'] == 'awaiting_input')
                self.poll_broker(runtime, probe)
        # Like target-driver's launchHereOrSkip, inventory is a before-birth
        # guard. An existing intent or a nondue presentation is not a birth.
        if observed.state == 'absent' and check_federation:
            report = self.get('/v1/federation/runtimes', scope=scope)
            nodes = [node for node in report['nodes'] if node['state'] == 'answered']
            live = [node['nodeId'] for node in nodes if any(
                r['scopeRef'] == scope and r['status'] not in TERMINAL and r['status'] != 'detached'
                for r in node['runtimes'])]
            elsewhere = any(node != report['localNodeId'] for node in live) and report['localNodeId'] not in live
            if elsewhere:
                bindings = self.get('/v1/placement/bindings', home='self', state='active')
                elsewhere = not any(b['scopeRef'] == scope and b['state'] == 'active' and
                    b['homeNodeId'] == report['localNodeId'] for b in bindings['bindings'])
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
        envelope = Envelope(id=mail['id'], obligation=mail.get('obligation'), kind='envelope',
            state='terminal' if detail.get('terminal') else mail['state'],
            delivery=detail.get('delivery'), created_at=ms(mail.get('createdAt')),
            presented_before=bool(detail['presentedTo']) if 'presentedTo' in detail else None,
            retry_at=ms(detail.get('retryAt')))
        seat, runtime, session = self.target(scope, check_federation=(
            mail['state'] == 'pending' and store['intent'] is None))
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
        if self.memos.anchored:
            tags['log_fed_memos'].append('injector_outcomes')
            fallback = self.memos.fallback.get(mail['id'])
            backoff = self.memos.backoff.get(identifier)
            refusal = Refusal(kind=(fallback if mail['id'] in self.memos.fallback else
                                   'transient' if backoff else 'none'),
                attempts=backoff['attempts'] if backoff else 0,
                last_at=backoff['at'] if backoff else None)
            birth = self.memos.birth.get(target)
            retry = Retry(kind='none')
            if birth:
                retry = Retry(kind=birth['kind'], attempts=birth['attempts'], last_at=birth['at'],
                              host_reason=birth['reason'] or '',
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
            hold = self.memos.quiet.get(identifier)
            seat = replace(seat, steer_capability_refused=identifier in self.memos.capability,
                quiet_hold=bool(hold), quiet_since=hold['since'] if hold else None,
                quiet_moved=False if hold else None)
            tags['broker_movement_dependent'] = bool(hold)
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
        if mail['state'] == 'presented':
            receipts = detail.get('presentedTo', [])
            receipt = max(receipts, key=lambda p: p.get('presentedAt', '')) if receipts else {}
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
