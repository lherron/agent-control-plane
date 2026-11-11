"""Landing facts and refusal fences; translation of policy/drive/landing.ts."""
import asyncio
import json
from .act_internal import (KICKER_MAX_NON_LANDING_STRIKES, KICKER_SUBMISSION_TTL_MS,
                           STEER_RETRY_BASE_MS, STEER_RETRY_MAX_MS, error_text, is_record)
from .act_digest_group import digest_group_of, digest_members
from .act_steer_hold import arm_quiet_pane_hold, clear_steer_hold, observe_seat_activity

LANDED_TYPES = {'submission.absorbed', 'submission.executed'}


def is_mid_turn_write(type, payload):
    return type == 'input.accepted' and payload is not None and payload.get('disposition') == 'attempted_steer'


TERMINAL_EXECUTION_SUFFIX = '+execution_observed'
REFUSED_TYPES = {'input.rejected', 'submission.rejected', 'submission.lost', 'submission.expired',
                 'submission.cancelled', 'submission.withdrawn'}


def parse_payload(record):
    try:
        parsed = json.loads(record['brokerEventJson'])
        return parsed if is_record(parsed) else None
    except (ValueError, TypeError):
        return None


def delivery_outcome_for(intent, event_type):
    if intent.delivery_outcome is not None:
        return intent.delivery_outcome
    if intent.door == 'preempt':
        return 'preempted_live_harness'
    if intent.door == 'launch':
        return 'launch_carried'
    return 'steered' if event_type in ('submission.absorbed', 'input.accepted') else 'executed'


async def commit_landing(server, intent, input):
    if intent.terminal_envelope_at is not None:
        prior_cause = intent.terminal_envelope_cause if intent.terminal_envelope_cause is not None else 'terminal'
        if not prior_cause.endswith(TERMINAL_EXECUTION_SUFFIX):
            server.store.mail_delivery.mark_terminal_envelope(intent.envelope_id, prior_cause+TERMINAL_EXECUTION_SUFFIX)
        server.store.mail_delivery.record_disposition(intent.envelope_id, input['runtimeId'], 'terminal_execution_observed')
        server.log('INFO', 'wrkq.kicker.terminal_execution_observed', dict(
            targetSessionRef=intent.target_session_ref, envelope=intent.envelope_id, runtimeId=input['runtimeId'],
            presentationId=intent.presentation_id, door=intent.door,
            **({} if intent.submission_id is None else {'inputId': intent.submission_id}),
            landedOn=input['eventType'], landingHrcSeq=input['landingHrcSeq'],
            terminalEnvelopeCause=intent.terminal_envelope_cause if intent.terminal_envelope_cause is not None else 'terminal',
            note='body executed after the envelope became terminal; recorded, not revived'))
        return 'held'
    outcome = delivery_outcome_for(intent, input['eventType'])
    is_reminder = (intent.form == 'reminder' and
        server.store.mail_delivery.get_presentation(intent.envelope_id, input['runtimeId']) is not None)
    if is_reminder:
        server.store.mail_delivery.record_reminder_landing(intent.envelope_id, input['runtimeId'], input['landingHrcSeq'])
    else:
        prior = server.store.mail_delivery.get_presentation(intent.envelope_id, input['runtimeId'])
        if prior is None or prior.presentation_id != intent.presentation_id:
            server.store.mail_delivery.record_presentation(envelope_id=intent.envelope_id,
                runtime_id=input['runtimeId'], target_session_ref=intent.target_session_ref,
                generation=intent.generation, presentation_id=intent.presentation_id,
                input_id=intent.submission_id, delivery_outcome=outcome, landing_hrc_seq=input['landingHrcSeq'])
    try:
        await server.ledger.present(dict(envelope=intent.envelope_id, node=server.node_id,
            **({} if intent.host_session_id is None else {'hostSessionId': intent.host_session_id}),
            **({} if intent.generation is None else {'generation': str(intent.generation)}),
            runtimeId=input['runtimeId'], driveAttemptId=intent.presentation_id,
            **({} if intent.submission_id is None else {'inputId': intent.submission_id}), deliveryOutcome=outcome))
    except Exception as error:
        if is_disposed_before_landing(error):
            server.store.mail_delivery.mark_terminal_envelope(intent.envelope_id, 'receipt_wrong_state')
            server.store.mail_delivery.record_disposition(intent.envelope_id, input['runtimeId'], 'terminal_before_receipt')
            server.log('INFO', 'wrkq.kicker.disposed_before_landing', dict(targetSessionRef=intent.target_session_ref,
                envelope=intent.envelope_id, runtimeId=input['runtimeId'], presentationId=intent.presentation_id,
                door=intent.door, note='body landed after the envelope was discharged; no receipt is possible'))
            return 'disposed'
        server.log('WARN', 'wrkq.kicker.presentation_commit_failed', dict(targetSessionRef=intent.target_session_ref,
            envelope=intent.envelope_id, runtimeId=input['runtimeId'], presentationId=intent.presentation_id,
            error=error_text(error)))
        return 'failed'
    server.store.mail_delivery.mark_receipt_committed(intent.envelope_id, input['runtimeId'])
    server.store.mail_delivery.clear_intent(intent.envelope_id)
    server.mail_kicker_delivery_backoff.pop(input['runtimeId'], None)
    clear_steer_hold(server, input['runtimeId'])
    server.store.mail_delivery.clear_non_landing_strikes(intent.envelope_id)
    server.log('INFO', 'wrkq.kicker.presented', dict(targetSessionRef=intent.target_session_ref,
        envelope=intent.envelope_id, runtimeId=input['runtimeId'], presentationId=intent.presentation_id,
        **({} if intent.submission_id is None else {'inputId': intent.submission_id}), door=intent.door,
        form=intent.form if digest_group_of(intent.presentation_id) is None else 'digest', deliveryOutcome=outcome,
        landingHrcSeq=input['landingHrcSeq'], landedOn=input['eventType']))
    return 'committed'


async def commit_landing_for_submission(server, intent, input):
    own = 'failed'
    for member in digest_members(server, intent):
        runtime_id = member.runtime_id if member.runtime_id is not None else input.get('runtimeId')
        if runtime_id is None:
            continue
        commit = await commit_landing(server, member, dict(input, runtimeId=runtime_id))
        if member.envelope_id == intent.envelope_id:
            own = commit
    return own


def is_disposed_before_landing(error):
    message = str(error)
    return 'wrong_state' in message


async def land_launch_if_started(server, intent):
    runtime_id = intent.runtime_id
    if runtime_id is None or intent.door != 'launch':
        return None
    started_events = await server.port.lifecycle_events(dict(eventKind='turn.started', runtimeId=runtime_id, limit=1))
    started = started_events[0] if started_events else None
    if started is None:
        return None
    return await commit_landing(server, intent, dict(runtimeId=runtime_id, eventType='turn.started', landingHrcSeq=started['hrcSeq']))


CAPABILITY_REFUSALS = {'steer_not_supported', 'unsupported:steer'}


async def steer_refusal_is_permanent(server, runtime_id, submission_id, reason):
    if reason in CAPABILITY_REFUSALS:
        return True
    if submission_id is None:
        return False
    result = (await server.port.broker_events_query(dict(op='admission-rejection', runtimeId=runtime_id,
                                                        submissionId=submission_id)))['result']
    return result is not None and result['op'] == 'admission-rejection' and result['layer'] == 'capability'


POLICY_OR_AUTHORITY_REFUSALS = {'guarded', 'authority-denied'}


async def steer_refusal_fallback(server, runtime_id, submission_id, reason):
    if await steer_refusal_is_permanent(server, runtime_id, submission_id, reason):
        return 'capability'
    if reason in POLICY_OR_AUTHORITY_REFUSALS:
        return 'turn'
    if submission_id is None:
        return None
    result = (await server.port.broker_events_query(dict(op='admission-rejection', runtimeId=runtime_id,
                                                        submissionId=submission_id)))['result']
    return ('turn' if result is not None and result['op'] == 'admission-rejection'
            and result['layer'] in ('policy', 'authority') else None)


def record_steer_fallback(server, envelope_id, runtime_id, fallback):
    server.mail_kicker_steer_fallback.add(envelope_id)
    if fallback == 'capability':
        server.mail_kicker_steer_refused.add(runtime_id)
    server.mail_kicker_delivery_backoff.pop(runtime_id, None)


def next_delivery_backoff_ms(server, runtime_id):
    previous = server.mail_kicker_delivery_backoff.get(runtime_id)
    next = STEER_RETRY_BASE_MS if previous is None else min(previous * 2, STEER_RETRY_MAX_MS)
    server.mail_kicker_delivery_backoff[runtime_id] = next
    return next


def clear_refused_intent(server, intent, reason, options=None):
    clear_refused_intents(server, [intent], reason, options or {})


def clear_refused_intents(server, intents, reason, options=None):
    options = options or {}
    intent = intents[0] if intents else None
    if intent is None:
        return
    for member in intents:
        server.store.mail_delivery.clear_intent(member.envelope_id)
        server.log('INFO', 'wrkq.kicker.landing_refused', dict(targetSessionRef=member.target_session_ref,
            envelope=member.envelope_id, door=member.door,
            **({} if member.submission_id is None else {'submissionId': member.submission_id}),
            **({} if member.runtime_id is None else {'runtimeId': member.runtime_id}), reason=reason,
            **{key: options[key] for key in ('refusalClass', 'fallbackDoor', 'retryInMs') if options.get(key) is not None}))
    if options.get('retryInMs') is None:
        server.wake(intent.target_session_ref, 'insert')
        return
    def wake():
        if not server.stopping:
            server.wake(intent.target_session_ref, 'insert')
    asyncio.get_running_loop().call_later(options['retryInMs']/1000, wake)


async def charge_non_landing_outcome(server, intent, runtime_id, cause):
    strikes = server.store.mail_delivery.record_non_landing_strike(intent.envelope_id, runtime_id)
    server.store.mail_delivery.close_refusal_window(intent.envelope_id, runtime_id)
    if strikes < KICKER_MAX_NON_LANDING_STRIKES:
        return 'struck'
    server.store.mail_delivery.clear_intent(intent.envelope_id)
    server.log('WARN', 'wrkq.kicker.non_landing_strikes_exhausted', dict(targetSessionRef=intent.target_session_ref,
        envelope=intent.envelope_id, runtimeId=runtime_id, door=intent.door, strikes=strikes, cause=cause,
        ttlMs=KICKER_SUBMISSION_TTL_MS))
    try:
        await server.fail_envelope_with_audit(dict(envelope=intent.envelope_id, reason='undeliverable',
            targetSessionRef=intent.target_session_ref, presentationId=intent.presentation_id,
            callSite='non_landing_strikes_exhausted'))
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.non_landing_fail_failed', dict(targetSessionRef=intent.target_session_ref,
            envelope=intent.envelope_id, error=error_text(error)))
    return 'exhausted'


async def refuse_intent(server, intent, reason, observed=None):
    members = digest_members(server, intent)
    runtime_id = intent.runtime_id
    if runtime_id is None:
        clear_refused_intents(server, members, reason)
        return 'refused'
    if intent.door == 'steer':
        fallback = await steer_refusal_fallback(server, runtime_id, intent.submission_id, reason)
        if fallback is not None:
            for member in members:
                record_steer_fallback(server, member.envelope_id, runtime_id, fallback)
            clear_refused_intents(server, members, reason, dict(
                refusalClass='permanent' if fallback == 'capability' else 'not_written', fallbackDoor='enqueue'))
            return 'refused'
    if intent.door == 'steer' and reason == QUIET_PANE_REFUSAL:
        await arm_quiet_pane_hold(server, runtime_id, observed)
    # TS promises a TTL-window strike in its comment but charges none here.
    clear_refused_intents(server, members, reason, dict(refusalClass='not_written',
                                                     retryInMs=next_delivery_backoff_ms(server, runtime_id)))
    return 'refused'


QUIET_PANE_REFUSAL = 'pane_not_quiescent'


async def observe_broker_landing(server, record):
    observe_seat_activity(server, record)
    if record['type'] == 'turn.started':
        intents = server.store.mail_delivery.list_launch_intents_for_runtime(record['runtimeId'])
        for intent in intents:
            await commit_landing(server, intent, dict(runtimeId=record['runtimeId'], eventType=record['type'],
                landingHrcSeq=(await server.port.events_head())['hrcSeq']))
        return
    if record['type'] == 'admission.requested':
        bind_admitted_submission(server, record)
        return
    if record['type'] != 'input.accepted' and record['type'] not in LANDED_TYPES and record['type'] not in REFUSED_TYPES:
        return
    payload = parse_payload(record)
    mid_turn_write = is_mid_turn_write(record['type'], payload)
    if record['type'] == 'input.accepted' and not mid_turn_write:
        return
    submission_id = (payload.get('submissionId') if payload.get('submissionId') is not None else payload.get('inputId')) if payload else None
    if not isinstance(submission_id, str):
        return
    intent = server.store.mail_delivery.get_intent_by_submission_id(submission_id)
    if intent is None:
        return
    if mid_turn_write or record['type'] in LANDED_TYPES:
        await commit_landing_for_submission(server, intent, dict(runtimeId=record['runtimeId'], eventType=record['type'],
            landingHrcSeq=(await server.port.events_head())['hrcSeq']))
        return
    reason = payload['reason'] if isinstance(payload.get('reason'), str) else record['type']
    if payload.get('deliveryEvidence') != 'not_written':
        for member in digest_members(server, intent):
            server.store.mail_delivery.mark_uncertain(member.envelope_id, reason, 'refusal_without_no_write_proof')
        return
    await refuse_intent(server, intent, reason, dict(invocationId=record['invocationId'], brokerSeq=record['seq']))


def bind_admitted_submission(server, record):
    payload = parse_payload(record)
    origin = payload.get('origin') if payload else None
    envelope_id = origin.get('envelopeId') if is_record(origin) else None
    submission_id = payload.get('submissionId') if payload else None
    if not isinstance(envelope_id, str) or not isinstance(submission_id, str):
        return
    intent = server.store.mail_delivery.get_intent(envelope_id)
    if (intent is None or intent.submission_id is not None or intent.terminal_envelope_at is not None
            or intent.runtime_id != record['runtimeId'] or intent.invocation_id != record['invocationId']
            or intent.broker_after_seq is None or record['seq'] <= intent.broker_after_seq):
        return
    for member in digest_members(server, intent):
        if member.submission_id is not None:
            continue
        server.store.mail_delivery.attach_admission(member.envelope_id, submission_id=submission_id)
