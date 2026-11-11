"""Write-ahead one-envelope delivery; translation of policy/drive/delivery.ts."""
from .act_contracts import HrcDomainError, HrcErrorCode
from .act_internal import KICKER_SUBMISSION_TTL_MS, error_text, parse_session_ref
from .presentation_text import format_backlog_digest, format_envelope_presentations, _ms
from .act_authority import participant_host_refusal_for, presentation_runtime_id_for
from .act_digest_group import digest_presentation_id
from .act_landing import land_launch_if_started, record_steer_fallback, steer_refusal_fallback
from .act_presentation import actionable_directives, sender_generation_for

PRE_LAUNCH_ASPD_CODES = {'compile-not-ok', 'admission-rejected'}


def is_definite_pre_launch_rejection(error):
    return (isinstance(error, HrcDomainError) and error.code == 'runtime_unavailable'
            and error.detail.get('route') == 'aspd' and str(error.detail.get('code')) in PRE_LAUNCH_ASPD_CODES)


def is_definite_dispatch_rejection(error):
    return (isinstance(error, HrcDomainError) and (error.code == HrcErrorCode.PRESENTATION_CONFLICT
            or is_definite_pre_launch_rejection(error) or is_retired_host_rejection(error) or is_launch_cwd_missing(error)))


def is_definite_seat_rejection(error):
    return is_definite_dispatch_rejection(error) or participant_host_refusal_for(error) is not None


def retry_parked_participant_soon(server, target_session_ref, error):
    participant_host = participant_host_refusal_for(error)
    if participant_host is not None:
        server.schedule_participant_host_retry(target_session_ref, participant_host['reason'])


def is_launch_cwd_missing(error):
    return isinstance(error, HrcDomainError) and error.code == 'cwd_missing'


async def fail_for_missing_cwd(server, target_session_ref, envelope_ids, error, wake_reason):
    server.log('WARN', 'wrkq.kicker.launch_cwd_missing', dict(targetSessionRef=target_session_ref,
        wakeReason=wake_reason, envelopes=list(envelope_ids),
        **({'cwd': error.detail['cwd']} if 'cwd' in error.detail else {}), message=error.message))
    for envelope in envelope_ids:
        server.store.mail_delivery.clear_intent(envelope)
        await server.fail_envelope_with_audit(dict(envelope=envelope, reason='undeliverable',
            detail=f'cwd_missing: {error.message}', targetSessionRef=target_session_ref, callSite='launch_cwd_missing'))


def is_retired_host_rejection(error):
    return (isinstance(error, HrcDomainError) and error.code == HrcErrorCode.STALE_CONTEXT
            and error.detail.get('reason') == 'host_session_retired')


def submit_injected(server, door, session, intent, prompt, options):
    return getattr(server.port, door)(session, intent, prompt, options)


def door_for(server, seat, envelope_ids, is_hold, preempt_authorized):
    if is_hold and preempt_authorized:
        return {'door': 'preempt'}
    if (seat['state'] in ('turn-active', 'idle') and seat['steerCapable']
            and seat['runtimeId'] not in server.mail_kicker_steer_refused
            and not any(envelope_id in server.mail_kicker_steer_fallback for envelope_id in envelope_ids)):
        return dict(door='steer', **({'deliveryOutcome': 'hold_refused_authority'} if is_hold else {}))
    return dict(door='enqueue', **({'deliveryOutcome': 'hold_refused_authority'} if is_hold else {}))


def intent_for_seat(intent, seat):
    if seat['state'] == 'absent' or (intent.get('presentation') or {}).get('operator') is None:
        return intent
    presentation = {key: value for key, value in intent['presentation'].items() if key != 'operator'}
    return dict(intent, presentation=presentation)


async def preview_presentation(server, item, session, runtime_id):
    result = await server.ledger.present(dict(envelope=item['envelope']['id'], preview=True, node=server.node_id,
        hostSessionId=session['hostSessionId'], generation=str(session['generation']),
        **({} if runtime_id is None else {'runtimeId': runtime_id})))
    presentation = item.get('presentation')
    return dict(hintStyle=recipient_hint_style(server, result['envelope'], session), envelope=result['envelope'],
        delivery=result['envelope']['delivery'], historyHint=item['form'] == 'full' and result['historyHint'],
        messageCount=result['messageCount'],
        **({} if result.get('lastMessageAt') is None else {'lastMessageAt': result['lastMessageAt']}), form=item['form'],
        **({} if presentation is None or presentation.turn_ended_at is None else {'turnEndedAt': presentation.turn_ended_at}),
        **(await sender_generation_for(server, result['envelope'])))


def origin_for(item):
    envelope = item['envelope']
    return dict(principalRef=envelope['from']['principalRef'],
        **({} if envelope['from'].get('scopeRef') is None else {'scopeRef': envelope['from']['scopeRef']}),
        envelopeId=envelope['id'])


def store_form_of(form):
    return 'full' if form == 'digest' else form


async def deliver_to_seat(server, target_session_ref, session, seat, item, wake_reason, drive_attempt_id=None):
    runtime_id = await presentation_runtime_id_for(server, session) if seat['state'] == 'absent' else seat['runtimeId']
    is_hold = item['envelope']['delivery'] == 'hold'
    intent_door_and_outcome = door_for(server, seat, [item['envelope']['id']], is_hold, False)
    door = intent_door_and_outcome['door']
    delivery_outcome = intent_door_and_outcome.get('deliveryOutcome')
    if door == 'enqueue':
        server.mail_kicker_steer_fallback.discard(item['envelope']['id'])
    runtime_intent = session.get('lastAppliedIntentJson')
    if runtime_intent is None:
        runtime_intent = await server.port.resolve_runtime_intent(parse_session_ref(target_session_ref)['scopeRef'], actionable_directives([item]))
    if runtime_intent is None:
        server.log('WARN', 'wrkq.kicker.delivery_unavailable', dict(targetSessionRef=target_session_ref,
            wakeReason=wake_reason, envelope=item['envelope']['id'], reason='no_runtime_intent_available'))
        return 'refused'
    try:
        presentable = await preview_presentation(server, item, session, runtime_id)
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.presentation_preview_failed', dict(targetSessionRef=target_session_ref,
            wakeReason=wake_reason, envelope=item['envelope']['id'], error=error_text(error)))
        return 'refused'
    prompt = format_envelope_presentations([presentable], server.now_ms())
    if is_hold:
        request = dict(target=target_session_ref, body=prompt, origin=origin_for(item),
                       ttlMs=KICKER_SUBMISSION_TTL_MS, turnPolicy='guarded')
        admission = await server.port.preempt_admission(session, request)
        if admission == 'authorized':
            door = 'preempt'
            delivery_outcome = None
        elif admission == 'preempt-unsupported':
            server.log('INFO', 'wrkq.kicker.hold_preempt_unsupported', dict(targetSessionRef=target_session_ref,
                wakeReason=wake_reason, envelope=item['envelope']['id'],
                **({} if runtime_id is None else {'runtimeId': runtime_id}), door=door, observedSeatState=seat['state']))
    presentation_id = f'present-{server.new_uuid()}'
    runtime = None if runtime_id is None else await server.port.runtime(runtime_id)
    invocation_id = runtime.get('activeInvocationId') if runtime is not None else None
    events_head = await server.port.events_head()
    seat_snapshot = None if runtime_id is None else await server.port.seat(runtime_id)
    intent = server.store.mail_delivery.open_intent(envelope_id=item['envelope']['id'], target_session_ref=target_session_ref,
        door=door, form=store_form_of(item['form']), presentation_id=presentation_id, runtime_id=runtime_id,
        host_session_id=session['hostSessionId'], generation=session['generation'], delivery_outcome=delivery_outcome,
        submitted_hrc_seq=events_head['hrcSeq'],
        **({} if invocation_id is None else dict(invocation_id=invocation_id,
            broker_after_seq=(seat_snapshot or {}).get('currentBrokerSeq') or 0)))
    if intent is None:
        return 'skipped'
    server.log('INFO', 'wrkq.kicker.delivery_intent', dict(
        **({} if drive_attempt_id is None else {'driveAttemptId': drive_attempt_id}), targetSessionRef=target_session_ref,
        wakeReason=wake_reason, envelope=item['envelope']['id'], door=door, form=item['form'], presentationId=presentation_id,
        **({} if runtime_id is None else {'runtimeId': runtime_id}), observedSeatState=seat['state'],
        **(dict(turnId=seat['turnId'], steerCapable=seat['steerCapable']) if seat['state'] == 'turn-active' else {})))
    try:
        body = await submit_injected(server, door, session, intent_for_seat(runtime_intent, seat), prompt,
            dict(waitForCompletion=False, ttlMs=KICKER_SUBMISSION_TTL_MS,
                 **({'turnPolicy': 'guarded'} if door == 'preempt' else {}), submissionOrigin=origin_for(item)))
    except Exception as error:
        if is_launch_cwd_missing(error):
            await fail_for_missing_cwd(server, target_session_ref, [item['envelope']['id']], error, wake_reason)
            return 'terminalized'
        not_written = is_definite_seat_rejection(error)
        if not_written:
            server.store.mail_delivery.clear_intent(item['envelope']['id'])
        else:
            server.store.mail_delivery.mark_uncertain(item['envelope']['id'], 'dispatch_error', 'dispatch_error')
        server.log('WARN', 'wrkq.kicker.delivery_failed', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
            envelope=item['envelope']['id'], door=door, error=error_text(error),
            deliveryEvidence='not_written' if not_written else 'uncertain'))
        retry_parked_participant_soon(server, target_session_ref, error)
        return 'refused'
    submission_id = body.get('submissionId') if body.get('submissionId') is not None else body.get('inputId')
    if body.get('admission') == 'rejected':
        server.store.mail_delivery.clear_intent(item['envelope']['id'])
        reason = body.get('reason') if body.get('reason') is not None else 'no_submission_identity'
        fallback = (await steer_refusal_fallback(server, runtime_id, body.get('submissionId'), reason)
                    if door == 'steer' and runtime_id is not None else None)
        if fallback is not None and runtime_id is not None:
            record_steer_fallback(server, item['envelope']['id'], runtime_id, fallback)
        server.log('WARN', 'wrkq.kicker.landing_refused', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
            envelope=item['envelope']['id'], door=door, reason=reason, phase='admission',
            **({} if fallback is None else {'fallbackDoor': 'enqueue'})))
        if fallback is not None:
            server.wake(target_session_ref, 'insert')
        return 'refused'
    if submission_id is None:
        server.store.mail_delivery.mark_uncertain(item['envelope']['id'], 'missing_submission_identity', 'admission_response')
        return 'submitted'
    server.store.mail_delivery.attach_admission(item['envelope']['id'], submission_id=submission_id,
        runtime_id=body.get('runtimeId'), host_session_id=body.get('hostSessionId'), generation=body.get('generation'))
    server.log('INFO', 'wrkq.kicker.delivery_admitted', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
        envelope=item['envelope']['id'], door=door, submissionId=submission_id,
        **({} if body.get('runtimeId') is None else {'runtimeId': body['runtimeId']})))
    return 'submitted'


async def deliver_digest_to_seat(server, target_session_ref, session, seat, items, wake_reason, drive_attempt_id=None):
    runtime_id = await presentation_runtime_id_for(server, session) if seat['state'] == 'absent' else seat['runtimeId']
    door = door_for(server, seat, [item['envelope']['id'] for item in items], False, False)['door']
    if door == 'enqueue':
        for item in items:
            server.mail_kicker_steer_fallback.discard(item['envelope']['id'])
    runtime_intent = session.get('lastAppliedIntentJson')
    if runtime_intent is None:
        runtime_intent = await server.port.resolve_runtime_intent(parse_session_ref(target_session_ref)['scopeRef'], actionable_directives(items))
    if runtime_intent is None:
        server.log('WARN', 'wrkq.kicker.delivery_unavailable', dict(targetSessionRef=target_session_ref,
            wakeReason=wake_reason, envelopes=[item['envelope']['id'] for item in items], form='digest', reason='no_runtime_intent_available'))
        return dict(outcome='refused', members=0)
    current = []
    for item in items:
        try:
            row = await server.ledger.envelope_show({'envelope': item['envelope']['id']})
            if row['state'] == 'pending' and not row['terminal']:
                current.append(row)
            else:
                server.log('INFO', 'wrkq.kicker.digest_member_dropped', dict(targetSessionRef=target_session_ref,
                    envelope=item['envelope']['id'], state=row['state']))
        except Exception as error:
            server.log('WARN', 'wrkq.kicker.presentation_preview_failed', dict(targetSessionRef=target_session_ref,
                wakeReason=wake_reason, envelope=item['envelope']['id'], form='digest', error=error_text(error)))
    current.sort(key=lambda row: _ms(row['createdAt']) or 0)
    if len(current) == 0:
        return dict(outcome='skipped', members=0)
    group_id = server.new_uuid()
    runtime = None if runtime_id is None else await server.port.runtime(runtime_id)
    invocation_id = runtime.get('activeInvocationId') if runtime is not None else None
    events_head = await server.port.events_head()
    seat_snapshot = None if runtime_id is None else await server.port.seat(runtime_id)
    opened = []
    for envelope in current:
        intent = server.store.mail_delivery.open_intent(envelope_id=envelope['id'], target_session_ref=target_session_ref,
            door=door, form=store_form_of('digest'), presentation_id=digest_presentation_id(group_id, envelope['id']),
            runtime_id=runtime_id, host_session_id=session['hostSessionId'], generation=session['generation'],
            delivery_outcome='hold_refused_authority' if envelope['delivery'] == 'hold' else None,
            submitted_hrc_seq=events_head['hrcSeq'],
            **({} if invocation_id is None else dict(invocation_id=invocation_id,
                broker_after_seq=(seat_snapshot or {}).get('currentBrokerSeq') or 0)))
        if intent is not None:
            opened.append(dict(envelope=envelope, intent=intent))
    leader = opened[0]['envelope'] if opened else None
    if leader is None:
        return dict(outcome='skipped', members=0)
    members = [entry['envelope']['id'] for entry in opened]
    for entry in opened:
        envelope, intent = entry['envelope'], entry['intent']
        server.log('INFO', 'wrkq.kicker.delivery_intent', dict(
            **({} if drive_attempt_id is None else {'driveAttemptId': drive_attempt_id}), targetSessionRef=target_session_ref,
            wakeReason=wake_reason, envelope=envelope['id'], door=door, form='digest', digestGroup=group_id,
            digestMembers=members, presentationId=intent.presentation_id,
            **({} if runtime_id is None else {'runtimeId': runtime_id}), observedSeatState=seat['state']))
    prompt = format_backlog_digest([entry['envelope'] for entry in opened], server.now_ms(),
        'legacy' if not opened else recipient_hint_style(server, opened[0]['envelope'], session))
    def clear_all():
        for id in members:
            server.store.mail_delivery.clear_intent(id)
    def uncertain_all(cause, kind):
        for id in members:
            server.store.mail_delivery.mark_uncertain(id, cause, kind)
    try:
        body = await submit_injected(server, door, session, intent_for_seat(runtime_intent, seat), prompt,
            dict(waitForCompletion=False, ttlMs=KICKER_SUBMISSION_TTL_MS, submissionOrigin=origin_for({'envelope': leader})))
    except Exception as error:
        if is_launch_cwd_missing(error):
            await fail_for_missing_cwd(server, target_session_ref, members, error, wake_reason)
            return dict(outcome='terminalized', members=len(members))
        not_written = is_definite_seat_rejection(error)
        if not_written:
            clear_all()
        else:
            uncertain_all('dispatch_error', 'dispatch_error')
        server.log('WARN', 'wrkq.kicker.delivery_failed', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
            envelopes=members, form='digest', door=door, error=error_text(error),
            deliveryEvidence='not_written' if not_written else 'uncertain'))
        retry_parked_participant_soon(server, target_session_ref, error)
        return dict(outcome='refused', members=len(members))
    submission_id = body.get('submissionId') if body.get('submissionId') is not None else body.get('inputId')
    if body.get('admission') == 'rejected':
        clear_all()
        reason = body.get('reason') if body.get('reason') is not None else 'no_submission_identity'
        fallback = (await steer_refusal_fallback(server, runtime_id, body.get('submissionId'), reason)
                    if door == 'steer' and runtime_id is not None else None)
        if fallback is not None and runtime_id is not None:
            for id in members:
                record_steer_fallback(server, id, runtime_id, fallback)
        server.log('WARN', 'wrkq.kicker.landing_refused', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
            envelopes=members, form='digest', door=door, reason=reason, phase='admission',
            **({} if fallback is None else {'fallbackDoor': 'enqueue'})))
        if fallback is not None:
            server.wake(target_session_ref, 'insert')
        return dict(outcome='refused', members=len(members))
    if submission_id is None:
        uncertain_all('missing_submission_identity', 'admission_response')
        return dict(outcome='submitted', members=len(members))
    for id in members:
        server.store.mail_delivery.attach_admission(id, submission_id=submission_id, runtime_id=body.get('runtimeId'),
            host_session_id=body.get('hostSessionId'), generation=body.get('generation'))
    server.log('INFO', 'wrkq.kicker.delivery_admitted', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
        envelopes=members, form='digest', digestGroup=group_id, door=door, submissionId=submission_id,
        **({} if body.get('runtimeId') is None else {'runtimeId': body['runtimeId']})))
    return dict(outcome='submitted', members=len(members))


async def deliver_by_cold_birth(server, target_session_ref, item, wake_reason):
    scope_ref = parse_session_ref(target_session_ref)['scopeRef']
    runtime_intent = await server.port.resolve_runtime_intent(scope_ref, actionable_directives([item]))
    if runtime_intent is None:
        server.log('WARN', 'wrkq.kicker.placement_unresolvable', dict(targetSessionRef=target_session_ref,
            wakeReason=wake_reason, envelope=item['envelope']['id']))
        return 'refused'
    presentation_id = f'present-{server.new_uuid()}'
    intent = server.store.mail_delivery.open_intent(envelope_id=item['envelope']['id'], target_session_ref=target_session_ref,
        door='launch', form=store_form_of(item['form']), presentation_id=presentation_id,
        submitted_hrc_seq=(await server.port.events_head())['hrcSeq'])
    if intent is None:
        return 'skipped'
    server.log('INFO', 'wrkq.kicker.delivery_intent', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
        envelope=item['envelope']['id'], door='launch', form=item['form'], presentationId=presentation_id, observedSeatState='absent'))
    session = await server.port.ensure_target_session(target_session_ref, runtime_intent, {'persistIntent': False})
    server.store.mail_delivery.resolve_birth_refusal(target_session_ref, 'birth established')
    try:
        presentable = await preview_presentation(server, item, session, await presentation_runtime_id_for(server, session))
    except Exception as error:
        server.store.mail_delivery.clear_intent(item['envelope']['id'])
        server.log('WARN', 'wrkq.kicker.presentation_preview_failed', dict(targetSessionRef=target_session_ref,
            wakeReason=wake_reason, envelope=item['envelope']['id'], error=error_text(error)))
        return 'refused'
    try:
        body = await submit_injected(server, 'invoke', session,
            session['lastAppliedIntentJson'] if session.get('lastAppliedIntentJson') is not None else runtime_intent,
            format_envelope_presentations([presentable], server.now_ms()),
            dict(waitForCompletion=False, ttlMs=KICKER_SUBMISSION_TTL_MS, submissionOrigin=origin_for(item), launchPromptOnColdBirth=True))
    except Exception as error:
        if is_definite_dispatch_rejection(error):
            server.store.mail_delivery.clear_intent(item['envelope']['id'])
            server.log('WARN', 'wrkq.kicker.birth_compile_rejected' if is_definite_pre_launch_rejection(error) else 'wrkq.kicker.delivery_failed',
                dict(targetSessionRef=target_session_ref, wakeReason=wake_reason, envelope=item['envelope']['id'], error=error.message, detail=error.detail))
            raise
        server.store.mail_delivery.mark_uncertain(item['envelope']['id'], 'dispatch_error', 'dispatch_error')
        raise
    runtime_id = body.get('runtimeId')
    if runtime_id is None:
        runtime_id = await presentation_runtime_id_for(server, session)
    submission_id = body.get('submissionId') if body.get('submissionId') is not None else body.get('inputId')
    if submission_id is None:
        server.store.mail_delivery.attach_admission(item['envelope']['id'], door='launch', runtime_id=runtime_id,
            host_session_id=body.get('hostSessionId'), generation=body.get('generation'))
        server.log('INFO', 'wrkq.kicker.launch_carried', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
            envelope=item['envelope']['id'], **({} if runtime_id is None else {'runtimeId': runtime_id}),
            **{k: body[k] for k in ('hostSessionId', 'generation') if k in body}))
        current = server.store.mail_delivery.get_intent(item['envelope']['id'])
        if current is not None:
            await land_launch_if_started(server, current)
        return 'submitted'
    server.store.mail_delivery.attach_admission(item['envelope']['id'], door='invoke', submission_id=submission_id,
        runtime_id=runtime_id, host_session_id=body.get('hostSessionId'), generation=body.get('generation'))
    server.log('INFO', 'wrkq.kicker.delivery_admitted', dict(targetSessionRef=target_session_ref, wakeReason=wake_reason,
        envelope=item['envelope']['id'], door='invoke', submissionId=submission_id,
        **({} if runtime_id is None else {'runtimeId': runtime_id})))
    return 'submitted'


def recipient_hint_style(server, envelope, session):
    principal = (envelope.get('to') or {}).get('principalRef') or ''
    hints = getattr(server, 'recipient_hints', None)
    if hints is None:
        return 'legacy'
    return hints.for_recipient(principal.removeprefix('agent:'),
        ((session.get('lastAppliedIntentJson') or {}).get('placement') or {}).get('projectRoot')) or 'legacy'
