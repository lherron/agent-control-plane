"""One pass for one target; translation of policy/drive/target-driver.ts."""
from datetime import datetime, timezone
from .act_hrc_facts import hrc_facts
from .act_internal import error_text
from .act_client import WrkqLedgerUnavailableError
from .act_authority import (birth_deferral_for, defer_birth_for_target, deterministic_birth_refusal_for,
    kicker_scope_ref_for, live_runtime_home_elsewhere, local_placement_refusal_for,
    participant_host_refusal_for, participant_only_refusal_for, skip_foreign_homed_target)
from .act_delivery import deliver_by_cold_birth, deliver_digest_to_seat, deliver_to_seat, is_retired_host_rejection
from .act_finished_task import close_fyi_for_finished_task
from .act_launch_recovery import fail_exhausted_launch, recover_failed_launch
from .act_presentation import classify_backlog_fyi, read_actionable_envelopes, summons_a_turn
from .act_seat import observe_broker_seat
from .act_steer_hold import steer_hold_for
from .presentation_text import _ms


async def birth_for_target(server, target_session_ref, scope_ref, actionable, wake_reason):
    summons = next((item for item in actionable if summons_a_turn(item['envelope'])), None)
    if summons is None:
        return
    facts = hrc_facts(server)
    try:
        outcome = await deliver_by_cold_birth(server, target_session_ref, summons, wake_reason)
        facts.invalidate_target(target_session_ref)
        if outcome == 'submitted' and len(actionable) > 1:
            server.wake(target_session_ref, wake_reason)
        return
    except Exception as error:
        facts.invalidate_target(target_session_ref)
        deferral = birth_deferral_for(error)
        if deferral is not None and scope_ref is not None:
            server.store.mail_delivery.clear_intent(summons['envelope']['id'])
            defer_birth_for_target(server, target_session_ref, scope_ref, deferral, wake_reason)
            return
        if is_retired_host_rejection(error):
            server.store.mail_delivery.clear_intent(summons['envelope']['id'])
            server.log('INFO', 'wrkq.kicker.birth_host_retired', dict(targetSessionRef=target_session_ref,
                wakeReason=wake_reason, envelope=summons['envelope']['id'],
                **{key: error.detail[key] for key in ('expectedHostSessionId', 'activeHostSessionId') if key in error.detail}))
            return
        local = local_placement_refusal_for(error)
        if local is not None:
            server.store.mail_delivery.clear_intent(summons['envelope']['id'])
            server.log('INFO', 'wrkq.kicker.birth_not_placeable_here', dict(targetSessionRef=target_session_ref,
                wakeReason=wake_reason, envelope=summons['envelope']['id'], nodeId=server.node_id, home=local['home'],
                **{k: local[k] for k in ('projectId', 'projectRoot') if local.get(k) is not None},
                source=local['source'], message=local['message']))
            if scope_ref is not None:
                server.store.mail_delivery.record_birth_refusal(target_session_ref=target_session_ref, scope_ref=scope_ref,
                    reason=f"no node seated {scope_ref}; node {server.node_id} (HOME={local['home']}) cannot host it: {local['message']}")
            return dict(outcome='birth-refused', notPlaceableHere=True)
        participant_only = participant_only_refusal_for(error)
        if participant_only is not None and scope_ref is not None:
            server.store.mail_delivery.clear_intent(summons['envelope']['id'])
            return await settle_participant_only_refusal(server, target_session_ref, scope_ref, summons, participant_only['message'], wake_reason)
        participant_host = participant_host_refusal_for(error)
        server.log('WARN', 'wrkq.kicker.birth_failed', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
            envelope=summons['envelope']['id'], error=error_text(error),
            **({} if participant_host is None else {'participantHostRefusal': participant_host['reason']})))
        if scope_ref is not None:
            server.store.mail_delivery.record_birth_refusal(target_session_ref=target_session_ref, scope_ref=scope_ref, reason=error_text(error))
        deterministic = deterministic_birth_refusal_for(error)
        if deterministic is not None:
            server.store.mail_delivery.clear_intent(summons['envelope']['id'])
            server.log('WARN', 'wrkq.kicker.birth_refusal_deterministic', dict(targetSessionRef=target_session_ref,
                wakeReason=wake_reason, envelope=summons['envelope']['id'], code=deterministic['code'],
                **({} if deterministic.get('source') is None else {'source': deterministic['source']}), message=deterministic['message']))
            try:
                terminal = await server.fail_undeliverable_mail(target_session_ref, dict(refusals=1,
                    callSite='birth_refused_deterministic', detail=f"HRC refused the birth ({deterministic['code']}): {deterministic['message']}"))
                if terminal is not None:
                    server.store.mail_delivery.resolve_birth_refusal(target_session_ref,
                        f"deterministic birth refusal; pending mail failed undeliverable: {deterministic['message']}")
                    server.mail_kicker_birth_sweep_backoff.pop(target_session_ref, None)
                    return dict(outcome='undeliverable', failed=terminal['failed'])
            except Exception as fail_error:
                server.log('WARN', 'wrkq.kicker.undeliverable_failed', dict(targetSessionRef=target_session_ref, error=error_text(fail_error)))
        intent = server.store.mail_delivery.get_intent(summons['envelope']['id'])
        if intent is not None and intent.door == 'launch':
            await recover_failed_launch(server, intent, error_text(error), participant_host)
            return dict(outcome='birth-refused', launchRetry=True)
        return dict(outcome='birth-refused')


async def settle_participant_only_refusal(server, target_session_ref, scope_ref, summons, message, wake_reason):
    server.log('WARN', 'wrkq.kicker.birth_refused_participant_only', dict(targetSessionRef=target_session_ref,
        wakeReason=wake_reason, envelope=summons['envelope']['id'], nodeId=server.node_id, message=message))
    placement = None
    try:
        placement = await live_runtime_home_elsewhere(server, scope_ref)
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.federated_runtimes_failed', dict(targetSessionRef=target_session_ref,
            scopeRef=scope_ref, error=error_text(error)))
    if placement is not None and placement['home'] is not None:
        skip_foreign_homed_target(server, target_session_ref, scope_ref, placement['home'], wake_reason)
        return
    if placement is not None and placement['complete'] is True:
        try:
            terminal = await server.fail_undeliverable_mail(target_session_ref,
                dict(refusals=1, callSite='birth_refused_deterministic', detail=f'birth_failed: {message}'))
            if terminal is not None:
                server.store.mail_delivery.resolve_birth_refusal(target_session_ref,
                    f'participant-only and live on no node; pending mail failed undeliverable: {message}')
                server.mail_kicker_birth_sweep_backoff.pop(target_session_ref, None)
                return dict(outcome='undeliverable', failed=terminal['failed'])
        except Exception as fail_error:
            server.log('WARN', 'wrkq.kicker.undeliverable_failed', dict(targetSessionRef=target_session_ref, error=error_text(fail_error)))
    server.log('INFO', 'wrkq.kicker.birth_not_placeable_here', dict(targetSessionRef=target_session_ref,
        wakeReason=wake_reason, envelope=summons['envelope']['id'], nodeId=server.node_id, source='participant-only',
        message=message, federatedRead='failed' if placement is None else 'incomplete'))
    server.store.mail_delivery.record_birth_refusal(target_session_ref=target_session_ref, scope_ref=scope_ref,
        reason=f'no node seated {scope_ref}; node {server.node_id} cannot seat it: {message}')
    return dict(outcome='birth-refused', notPlaceableHere=True)


async def drive_mail_target_once(server, target_session_ref, wake_reason):
    drive_attempt_id = f'drive-{server.new_uuid()}'
    started_at = server.now_ms()
    def phase(name, outcome, detail=None):
        server.log('INFO', 'wrkq.kicker.drive_phase', dict(driveAttemptId=drive_attempt_id,
            targetSessionRef=target_session_ref, wakeReason=wake_reason, phase=name, outcome=outcome,
            elapsedMs=server.now_ms()-started_at, **(detail or {})))
    phase('wake_receipt', 'started')
    summary = dict(considered=0, skipped=0, attempted=0, admitted=0, presented=0, held=0, refused=0, unavailable=0, terminalized=0)
    def complete(outcome, extra=None):
        server.log('INFO', 'wrkq.kicker.drive_completed', dict(driveAttemptId=drive_attempt_id,
            targetSessionRef=target_session_ref, wakeReason=wake_reason, outcome=outcome, elapsedMs=server.now_ms()-started_at,
            **summary, stillPending=max(0, summary['considered']-summary['presented']-summary['held']-summary['terminalized']), **(extra or {})))
    def complete_birth(outcome):
        if outcome is not None and outcome['outcome'] == 'undeliverable':
            summary['terminalized'] = outcome['failed']
            complete('undeliverable', {'recovery': 'sender_notice'})
            return
        if outcome is not None and outcome['outcome'] == 'birth-refused' and outcome.get('notPlaceableHere') is True:
            complete('not_placeable_here', {'recovery': 'periodic_wake'})
            return
        complete(outcome['outcome'] if outcome is not None else 'birth_deferred', {'recovery': 'periodic_wake'})
    scope_ref = kicker_scope_ref_for(target_session_ref)
    facts = hrc_facts(server)
    try:
        foreign = None if scope_ref is None else await facts.foreign_home(scope_ref)
        phase('home_resolution', 'ok', {} if scope_ref is None else {'scopeRef': scope_ref})
    except Exception as error:
        phase('home_resolution', 'failed', {'diagnostic': bounded_failure('target_resolution', error)})
        complete('deferred', {'recovery': 'periodic_wake'})
        return
    if scope_ref is not None and foreign is not None:
        skip_foreign_homed_target(server, target_session_ref, scope_ref, foreign, wake_reason)
        phase('home_resolution', 'skipped', dict(homeNodeId=foreign['homeNodeId'], reason='foreign_home'))
        complete('skipped')
        return
    async def launch_here_or_skip():
        if scope_ref is None:
            return True
        try:
            placement = await live_runtime_home_elsewhere(server, scope_ref)
            phase('federated_runtimes', 'ok', dict(
                **({} if placement['home'] is None else {'homeNodeId': placement['home']['homeNodeId']}), complete=placement['complete']))
        except Exception as error:
            phase('federated_runtimes', 'failed', {'diagnostic': bounded_failure('federated_runtimes', error)})
            complete('deferred', {'recovery': 'periodic_wake'})
            return False
        if placement['home'] is None:
            return True
        skip_foreign_homed_target(server, target_session_ref, scope_ref, placement['home'], wake_reason)
        phase('home_resolution', 'skipped', dict(homeNodeId=placement['home']['homeNodeId'], reason='foreign_home', source=placement['home']['source']))
        complete('skipped')
        return False
    try:
        session = await facts.target(target_session_ref)
        phase('target_session_lookup', 'ok', dict(sessionFound=False) if session is None else
              dict(sessionFound=True, hostSessionId=session['hostSessionId'], generation=session['generation']))
    except Exception as error:
        phase('target_session_lookup', 'failed', {'diagnostic': bounded_failure('session_lookup', error)})
        complete('deferred', {'recovery': 'periodic_wake'})
        return
    if session is not None:
        await server.deliver_failure_notices(target_session_ref, session)
    try:
        actionable = await read_actionable_envelopes(server, target_session_ref)
    except Exception as error:
        server.log('WARN' if isinstance(error, WrkqLedgerUnavailableError) else 'ERROR', 'wrkq.kicker.pending_view_failed',
            dict(targetSessionRef=target_session_ref, wakeReason=wake_reason, error=error_text(error)))
        phase('pending_view', 'failed', {'diagnostic': bounded_failure('ledger_read', error)})
        complete('deferred', {'recovery': 'periodic_wake'})
        return
    summary['considered'] = len(actionable)
    phase('pending_view', 'ok', {'envelopeIds': bounded_envelope_ids([item['envelope']['id'] for item in actionable])})
    if len(actionable) == 0:
        complete('empty')
        return {'outcome': 'empty'}
    if facts.serving:
        try:
            foreign = None if scope_ref is None else await facts.foreign_home(scope_ref, {'fresh': True})
            session = await facts.target(target_session_ref, {'fresh': True})
            phase('action_fence', 'ok', dict(sessionFound=session is not None,
                **({} if session is None else dict(hostSessionId=session['hostSessionId'], generation=session['generation']))))
        except Exception as error:
            phase('action_fence', 'failed', {'diagnostic': bounded_failure('action_fence', error)})
            complete('deferred', {'recovery': 'periodic_wake'})
            return
        if scope_ref is not None and foreign is not None:
            skip_foreign_homed_target(server, target_session_ref, scope_ref, foreign, wake_reason)
            phase('home_resolution', 'skipped', dict(homeNodeId=foreign['homeNodeId'], reason='foreign_home'))
            complete('skipped')
            return
    remaining = []
    for item in actionable:
        if await fail_exhausted_launch(server, item['envelope']['id'], target_session_ref):
            summary['terminalized'] += 1
        else:
            remaining.append(item)
    actionable = remaining
    if len(actionable) == 0:
        complete('undeliverable')
        return dict(outcome='undeliverable', failed=summary['terminalized'])
    if (server.mail_kicker_birth_sweep_backoff.get(target_session_ref, {}).get('nextAtMs', 0) > server.now_ms()
            and any(server.store.launch_failures.get(item['envelope']['id']) is not None for item in actionable)):
        complete('birth_backoff', {'recovery': 'periodic_wake'})
        return dict(outcome='birth-refused', launchRetry=True)
    if session is None:
        phase('runtime_selection', 'skipped', {'reason': 'no_target_session'})
        if any(summons_a_turn(item['envelope']) for item in actionable) and not (await launch_here_or_skip()):
            return
        outcome = await birth_for_target(server, target_session_ref, scope_ref, actionable, wake_reason)
        complete_birth(outcome)
        return outcome
    try:
        seat = await observe_broker_seat(server, session)
    except Exception as error:
        phase('seat_probe', 'failed', {'diagnostic': bounded_failure('broker_probe', error)})
        for item in actionable:
            record_deferred_diagnostic(server, item['envelope']['id'], dict(driveAttemptId=drive_attempt_id,
                targetSessionRef=target_session_ref, wakeReason=wake_reason, outcome='broker_probe_failed',
                observedSeatState='unavailable', runtimeId=None, invocationId=None, diagnostic=None))
        summary['unavailable'] = len(actionable)
        complete('deferred', {'recovery': 'periodic_wake'})
        return
    phase('runtime_selection', 'ok', dict(**({'runtimeId': seat['runtimeId']} if 'runtimeId' in seat else {}), observedSeatState=seat['state']))
    phase('seat_probe', 'failed' if seat['state'] == 'unavailable' else 'ok', dict(
        **({'runtimeId': seat['runtimeId']} if 'runtimeId' in seat else {}), observedSeatState=seat['state'],
        **({'probeDiagnostic': seat['probeDiagnostic']} if seat['state'] == 'unavailable' else {})))
    if seat['state'] == 'absent' and any(summons_a_turn(item['envelope']) for item in actionable):
        if not (await launch_here_or_skip()):
            return
        outcome = await birth_for_target(server, target_session_ref, scope_ref, actionable, wake_reason)
        complete_birth(outcome)
        return outcome
    if seat['state'] == 'absent':
        closed = await close_fyi_for_finished_task(server, dict(driveAttemptId=drive_attempt_id,
            targetSessionRef=target_session_ref, scopeRef=scope_ref, actionable=actionable))
        if closed is not None:
            summary['terminalized'] = closed
            complete('target_task_terminal')
            return dict(outcome='undeliverable', failed=closed)
    if seat['state'] in ('unavailable', 'starting', 'stopping', 'turn-observed'):
        summary['unavailable'] = len(actionable)
        complete('deferred', {'recovery': 'periodic_wake'})
        server.log('INFO', 'wrkq.kicker.seat_not_ready', dict(driveAttemptId=drive_attempt_id, targetSessionRef=target_session_ref,
            wakeReason=wake_reason, observedSeatState=seat['state'], envelopeIds=bounded_envelope_ids([item['envelope']['id'] for item in actionable]),
            **(dict(runtimeId=seat['runtimeId'], invocationId=seat['invocationId'], probeDiagnostic=seat['probeDiagnostic'])
               if seat['state'] == 'unavailable' else {})))
        for item in actionable:
            record_deferred_diagnostic(server, item['envelope']['id'], dict(driveAttemptId=drive_attempt_id,
                targetSessionRef=target_session_ref, wakeReason=wake_reason, outcome=f"seat_{seat['state']}",
                observedSeatState=seat['state'], runtimeId=seat.get('runtimeId'),
                invocationId=seat['invocationId'] if seat['state'] == 'unavailable' else None,
                diagnostic=seat['probeDiagnostic'] if seat['state'] == 'unavailable' else None))
        return
    if seat['state'] == 'terminal':
        server.log('INFO', 'wrkq.kicker.seat_not_ready', dict(driveAttemptId=drive_attempt_id, targetSessionRef=target_session_ref,
            wakeReason=wake_reason, observedSeatState=seat['state'], envelopeIds=bounded_envelope_ids([item['envelope']['id'] for item in actionable])))
        summary['skipped'] = len(actionable)
        complete('terminal_runtime', {'recovery': 'runtime_lapse_reconciliation'})
        return
    hold = steer_hold_for(server, seat)
    if hold is not None:
        summary['skipped'] = len(actionable)
        complete('steer_held', dict(hold=hold, recovery='periodic_wake'))
        return
    classified = classify_backlog_fyi(actionable, dict(runtimeBornAt=await runtime_born_at(server, session, seat), now=server.now_ms()))
    digest = [item for item in classified if item['form'] == 'digest']
    per_envelope = [item for item in classified if item['form'] != 'digest']
    for item in per_envelope:
        summary['attempted'] += 1
        try:
            outcome = await deliver_to_seat(server, target_session_ref, session, seat, item, wake_reason, drive_attempt_id)
        except Exception as error:
            server.log('WARN', 'wrkq.kicker.delivery_failed', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
                envelope=item['envelope']['id'], error=error_text(error)))
            outcome = 'refused'
        if outcome == 'refused':
            summary['refused'] += 1
            continue
        if outcome == 'terminalized':
            summary['terminalized'] += 1
            continue
        if outcome == 'skipped':
            summary['skipped'] += 1
            continue
        summary['admitted'] += 1
        record_recovery_diagnostic(server, item['envelope']['id'], dict(driveAttemptId=drive_attempt_id,
            targetSessionRef=target_session_ref, wakeReason=wake_reason, outcome='admitted', observedSeatState=seat['state'],
            runtimeId=seat.get('runtimeId'), invocationId=None, diagnostic=None))
    if len(digest) > 0:
        summary['attempted'] += len(digest)
        try:
            result = await deliver_digest_to_seat(server, target_session_ref, session, seat, digest, wake_reason, drive_attempt_id)
        except Exception as error:
            server.log('WARN', 'wrkq.kicker.delivery_failed', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
                envelopes=[item['envelope']['id'] for item in digest], form='digest', error=error_text(error)))
            result = dict(outcome='refused', members=len(digest))
        outcome, members = result['outcome'], result['members']
        if outcome == 'submitted':
            summary['admitted'] += members
        elif outcome == 'terminalized':
            summary['terminalized'] += members
        elif outcome == 'refused':
            summary['refused'] += len(digest)
        else:
            summary['skipped'] += len(digest)
    complete('completed')


async def runtime_born_at(server, session, seat):
    if 'runtimeId' not in seat:
        return None
    if seat.get('runtimeCreatedAt') is not None:
        return seat['runtimeCreatedAt']
    try:
        runtime = next((candidate for candidate in await server.port.runtimes_by_host_session(session['hostSessionId'])
                        if candidate['runtimeId'] == seat['runtimeId']), None)
        if runtime is None:
            server.log('INFO', 'wrkq.kicker.runtime_birth_unknown', dict(runtimeId=seat['runtimeId'], reason='runtime_not_listed'))
        return runtime.get('createdAt') if runtime is not None else None
    except Exception as error:
        server.log('INFO', 'wrkq.kicker.runtime_birth_unknown', dict(runtimeId=seat['runtimeId'], error=error_text(error)))
        return None


MAX_ENVELOPE_IDS = 32


def bounded_envelope_ids(ids):
    return ids if len(ids) <= MAX_ENVELOPE_IDS else [*ids[:MAX_ENVELOPE_IDS], f'…[{len(ids)-MAX_ENVELOPE_IDS} more]']


def bounded_failure(boundary, error):
    value = error_text(error)
    raw = value.encode('utf-16-le', 'surrogatepass')
    return dict(boundary=boundary, message=value if len(raw)//2 <= 240 else raw[:227*2].decode('utf-16-le', 'surrogatepass')+'…[truncated]')


def record_deferred_diagnostic(server, envelope_id, input):
    diagnostics = getattr(server.store, 'drive_diagnostics', None)
    prior = diagnostics.latest(envelope_id) if diagnostics is not None else None
    if diagnostics is not None:
        diagnostics.record(envelope_id=envelope_id, drive_attempt_id=input['driveAttemptId'], target_session_ref=input['targetSessionRef'],
            wake_reason=input['wakeReason'], outcome=input['outcome'], observed_seat_state=input['observedSeatState'],
            runtime_id=input['runtimeId'], invocation_id=input['invocationId'], diagnostic=input['diagnostic'],
            prior_drive_attempt_id=prior.drive_attempt_id if prior is not None else None, recovered_at=None)


def record_recovery_diagnostic(server, envelope_id, input):
    diagnostics = getattr(server.store, 'drive_diagnostics', None)
    prior = diagnostics.latest(envelope_id) if diagnostics is not None else None
    recovered_at = (datetime.fromtimestamp(server.now_ms()/1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                    if prior is not None and prior.observed_seat_state == 'unavailable' else None)
    if diagnostics is not None:
        diagnostics.record(envelope_id=envelope_id, drive_attempt_id=input['driveAttemptId'], target_session_ref=input['targetSessionRef'],
            wake_reason=input['wakeReason'], outcome=input['outcome'], observed_seat_state=input['observedSeatState'],
            runtime_id=input['runtimeId'], invocation_id=input['invocationId'], diagnostic=input['diagnostic'],
            prior_drive_attempt_id=prior.drive_attempt_id if prior is not None else None, recovered_at=recovered_at)
    if recovered_at is not None:
        server.log('INFO', 'wrkq.kicker.drive_recovered', dict(driveAttemptId=input['driveAttemptId'],
            **({'priorDriveAttemptId': prior.drive_attempt_id} if prior is not None else {}),
            targetSessionRef=input['targetSessionRef'], envelopeId=envelope_id,
            timeToRecoveryMs=_ms(recovered_at)-_ms(prior.created_at if prior is not None else recovered_at)))
