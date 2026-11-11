"""§5 — sender-side failure notices; translation of policy/terminal/failure-notices.ts.

fyi-class: rendered from the ledger row, carrying no envelope and creating no
obligation. It rides the scope's LIVE GENERATION and nothing else.
"""
import hashlib
import json
from .act_authority import kicker_scope_ref_for
from .act_hrc_facts import hrc_facts
from .act_internal import (FAILURE_NOTICE_BACKOFF_BASE_MS, FAILURE_NOTICE_BACKOFF_MAX_MS,
                           FAILURE_NOTICE_MAX_ATTEMPTS, KICKER_SUBMISSION_TTL_MS, error_text, is_record,
                           parse_session_ref)
from .act_scope import target_session_ref_for_ledger_scope
from .act_seat import observe_broker_seat
from .presentation_text import format_envelope_failure_notice


def _sha256(*parts):
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode('utf-8'))
    return digest.hexdigest()


async def deliver_failure_notices(server, target_session_ref, seat_session):
    session = seat_session
    notices = server.store.mail_delivery.list_undelivered_failure_notices(target_session_ref)
    if len(notices) == 0:
        server.mail_kicker_failure_notice_backoff.pop(target_session_ref, None)
        return
    envelopes = sorted(notice.envelope_id for notice in notices)
    notice_set = _sha256(target_session_ref, '\0', '\0'.join(envelopes))
    backoff = server.mail_kicker_failure_notice_backoff.get(target_session_ref)
    if backoff is not None and backoff['key'] != notice_set:
        server.mail_kicker_failure_notice_backoff.pop(target_session_ref, None)
        backoff = None
    if backoff is not None and (backoff['exhausted'] or backoff['nextAtMs'] > server.now_ms()):
        return
    facts = hrc_facts(server)
    if facts.serving:
        if target_session_ref not in await facts.live_session_refs():
            return
        fresh = await facts.target(target_session_ref, {'fresh': True})
        if fresh is None:
            return
        session = fresh
    seat = await observe_broker_seat(server, session)
    if seat['state'] != 'idle' and seat['state'] != 'turn-active':
        return
    runtime_id = seat['runtimeId']
    if backoff is not None and backoff.get('parkedRuntimeId') == runtime_id:
        return
    intent = session.get('lastAppliedIntentJson')
    if intent is None:
        intent = await server.port.resolve_runtime_intent(parse_session_ref(target_session_ref)['scopeRef'], None)
    if intent is None:
        return
    prompt = '\n\n'.join(notice.notice for notice in notices)
    idempotency_key = 'hrc-mail-failure-notice-' + _sha256(
        target_session_ref, '\0', runtime_id, '\0', '\0'.join(envelopes))
    attempts = (0 if backoff is None else backoff['attempts']) + 1
    exhausted = attempts >= FAILURE_NOTICE_MAX_ATTEMPTS
    try:
        body = await server.port.enqueue(session, intent, prompt, dict(
            waitForCompletion=False, ttlMs=KICKER_SUBMISSION_TTL_MS, idempotencyKey=idempotency_key,
            submissionOrigin=dict(principalRef='system:hrc-kicker', scopeRef=session['scopeRef'])))
        if body['status'] != 'started':
            server.mail_kicker_failure_notice_backoff[target_session_ref] = dict(
                key=notice_set, parkedRuntimeId=runtime_id, exhausted=exhausted, attempts=attempts,
                nextAtMs=server.now_ms())
            server.log('WARN', 'wrkq.kicker.failure_notice_parked', dict(
                targetSessionRef=target_session_ref, runtimeId=runtime_id, envelopes=envelopes, attempts=attempts,
                reason='attempts_exhausted' if exhausted else 'replayed_non_start', status=body['status']))
            return
        server.mail_kicker_failure_notice_backoff.pop(target_session_ref, None)
        server.store.mail_delivery.mark_failure_notices_delivered(target_session_ref, envelopes)
        server.log('INFO', 'wrkq.kicker.failure_notice_delivered', dict(
            targetSessionRef=target_session_ref, runId=body.get('runId'), envelopes=envelopes))
    except Exception as error:
        delay_ms = 0 if attempts == 1 else min(
            FAILURE_NOTICE_BACKOFF_BASE_MS * 2 ** (attempts - 2), FAILURE_NOTICE_BACKOFF_MAX_MS)
        server.mail_kicker_failure_notice_backoff[target_session_ref] = dict(
            key=notice_set, exhausted=exhausted, attempts=attempts, nextAtMs=server.now_ms() + delay_ms)
        if exhausted:
            server.log('WARN', 'wrkq.kicker.failure_notice_parked', dict(
                targetSessionRef=target_session_ref, runtimeId=runtime_id, envelopes=envelopes, attempts=attempts,
                reason='attempts_exhausted', error=error_text(error)))
            return
        server.log('WARN', 'wrkq.kicker.failure_notice_failed', dict(
            targetSessionRef=target_session_ref, runtimeId=runtime_id, envelopes=envelopes, attempt=attempts,
            nextAttemptInMs=delay_ms, error=error_text(error)))


async def queue_failure_notice(server, event):
    """§5 — queue the sender-side notice for one `envelope.failed` off the tail."""
    envelope_id = event.get('resourceId')
    if envelope_id is None:
        return
    reason = failure_reason_for(event.get('payload'))
    if reason is None:
        return
    envelope = await server.ledger.envelope_show({'envelope': envelope_id})
    if envelope.get('obligation') != 'reply_required':
        return
    sender_scope = envelope['from'].get('scopeRef')
    if sender_scope is None:
        return
    target_session_ref = target_session_ref_for_ledger_scope(sender_scope)
    if target_session_ref is None:
        return
    canonical_scope = kicker_scope_ref_for(target_session_ref)
    bindings = await server.port.local_placement_bindings()
    homed = any(binding['scopeRef'] == canonical_scope and binding['state'] == 'active'
                and binding['homeNodeId'] == server.node_id for binding in bindings['bindings'])
    if not homed and (await hrc_facts(server).target(target_session_ref)) is None:
        return
    payload = failed_payload(event.get('payload'))
    runtime_id = None if payload is None else payload.get('runtime_id')
    detail = payload.get('detail') if payload is not None and isinstance(payload.get('detail'), str) else None
    notice = format_envelope_failure_notice(envelope, reason, dict(
        **({} if runtime_id is None else {'runtimeId': runtime_id}),
        **({} if detail is None else {'detail': detail})), now=server.now_ms())
    if not server.store.mail_delivery.record_failure_notice(
            envelope_id=envelope_id, target_session_ref=target_session_ref, notice=notice):
        return
    server.log('INFO', 'wrkq.kicker.failure_notice_queued', dict(
        targetSessionRef=target_session_ref, envelope=envelope_id, reason=reason))
    server.wake(target_session_ref, 'insert')


def failed_payload(raw):
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return parsed if is_record(parsed) else None


FAILURE_REASONS = {'runtime_terminated', 'ignored', 'undeliverable', 'legacy'}


def failure_reason_for(raw):
    payload = failed_payload(raw)
    reason = None if payload is None else payload.get('reason')
    if reason is None:
        return None
    return reason if reason in FAILURE_REASONS else None
