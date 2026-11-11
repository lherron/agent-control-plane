"""Launch retry budget; translation of policy/drive/launch-recovery.ts."""
from .act_internal import (BIRTH_SWEEP_BACKOFF_BASE_MS, PARTICIPANT_HOST_GIVE_UP_MS,
                           parse_session_ref, participant_host_retry_in_ms)


async def fail_exhausted_launch(server, envelope_id, target_session_ref):
    failure = server.store.launch_failures.get(envelope_id)
    if failure is None:
        return False
    exhausted = (failure.attempts >= 3 if failure.participant_host_since_ms is None else
                 server.now_ms() - failure.participant_host_since_ms >= PARTICIPANT_HOST_GIVE_UP_MS)
    if not exhausted:
        return False
    row = await server.ledger.envelope_show({'envelope': envelope_id})
    if not row['terminal'] and row['state'] == 'pending' and len(row['presentedTo']) == 0:
        await server.fail_envelope_with_audit(dict(envelope=envelope_id, targetSessionRef=target_session_ref,
            reason='undeliverable', detail=f'birth_failed: {failure.last_error}', callSite='launch_birth_exhausted'))
    return True


async def recover_failed_launch(server, intent, error, participant_host=None):
    current = server.store.mail_delivery.get_intent(intent.envelope_id)
    if current is None or current.presentation_id != intent.presentation_id or current.door != 'launch':
        return
    row = await server.ledger.envelope_show({'envelope': intent.envelope_id})
    if row['terminal'] or row['state'] != 'pending' or len(row['presentedTo']) > 0:
        return
    current = server.store.mail_delivery.get_intent(intent.envelope_id)
    if current is None or current.presentation_id != intent.presentation_id:
        return
    attempts = server.store.launch_failures.record(intent.envelope_id, intent.presentation_id, error,
        None if participant_host is None else server.now_ms())
    server.store.mail_delivery.record_birth_refusal(target_session_ref=intent.target_session_ref,
        scope_ref=parse_session_ref(intent.target_session_ref)['scopeRef'], reason=error)
    # TS also clears an intent just marked dispatch_error uncertain by delivery.ts.
    server.store.mail_delivery.clear_intent(intent.envelope_id)
    server.mail_kicker_stalled_delivery_announced.discard(intent.envelope_id)
    next_attempt_in_ms = (BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1) if participant_host is None
                          else participant_host_retry_in_ms(attempts))
    server.mail_kicker_birth_sweep_backoff[intent.target_session_ref] = dict(attempts=attempts,
        nextAtMs=server.now_ms()+next_attempt_in_ms, **({} if participant_host is None else {'participantHost': True}))
    server.log('WARN', 'wrkq.kicker.launch_birth_released', dict(envelope=intent.envelope_id,
        targetSessionRef=intent.target_session_ref, presentationId=intent.presentation_id, attempts=attempts,
        error=error, **({} if participant_host is None else {'participantHostRefusal': participant_host['reason']}),
        nextAttemptInMs=next_attempt_in_ms))
    await fail_exhausted_launch(server, intent.envelope_id, intent.target_session_ref)
