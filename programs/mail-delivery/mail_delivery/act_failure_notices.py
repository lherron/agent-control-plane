"""§5 — sender-side failure notices; translation of policy/terminal/failure-notices.ts.

fyi-class: rendered from the ledger row, carrying no envelope and creating no
obligation. It rides the scope's LIVE GENERATION and nothing else. Its door is
the port's own (T-13292): see deliver_failure_notices.
"""
import asyncio
import hashlib
from .act_authority import kicker_scope_ref_for
from .act_delivery import door_for, is_definite_seat_rejection
from .act_hrc_facts import hrc_facts
from .act_internal import (FAILURE_NOTICE_BACKOFF_BASE_MS, FAILURE_NOTICE_BACKOFF_MAX_MS,
                           FAILURE_NOTICE_MAX_ATTEMPTS, KICKER_SUBMISSION_TTL_MS, error_text, is_record,
                           parse_session_ref)
from .act_landing import LANDED_TYPES, REFUSED_TYPES, is_mid_turn_write, parse_payload
from .act_scope import target_session_ref_for_ledger_scope
from .act_seat import observe_broker_seat
from .presentation_text import format_envelope_failure_notice
from .store import _js_json_parse


def _sha256(*parts):
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode('utf-8'))
    return digest.hexdigest()


async def deliver_failure_notices(server, target_session_ref, seat_session):
    """Offer the sender's undelivered notices through the mail door (T-13292).

    The port's own rule; the TypeScript injector always enqueues and awaits. A
    notice takes the door `door_for` gives the seat (steer when live and
    steer-capable, enqueue otherwise). A steer is awaited only to admission and
    counts as delivered when its landing fact arrives on the broker stream; an
    enqueue runs as its own task, so the drive never waits for HRC's answer.
    At most one notice submission per target is outstanding.
    """
    if server.mail_kicker_failure_notice_outstanding.get(target_session_ref) is not None:
        return
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
    if server.mail_kicker_failure_notice_outstanding.get(target_session_ref) is not None:
        return  # another pass claimed the target while this one awaited HRC
    door = door_for(server, seat, [], False, False)['door']
    if door == 'steer' and notice_set in server.mail_kicker_failure_notice_steer_fallback:
        door = 'enqueue'
    prompt = '\n\n'.join(notice.notice for notice in notices)
    attempts = (0 if backoff is None else backoff['attempts']) + 1
    claim = dict(door=door, envelopes=envelopes, noticeSet=notice_set, runtimeId=runtime_id, attempts=attempts,
                 submissionId=None)
    server.mail_kicker_failure_notice_outstanding[target_session_ref] = claim
    origin = dict(principalRef=NOTICE_PRINCIPAL, scopeRef=session['scopeRef'])
    if door == 'enqueue':
        idempotency_key = 'hrc-mail-failure-notice-' + _sha256(
            target_session_ref, '\0', runtime_id, '\0', '\0'.join(envelopes))
        server.spawn(_enqueue_notice(server, target_session_ref, session, intent, prompt, claim, dict(
            waitForCompletion=False, ttlMs=KICKER_SUBMISSION_TTL_MS, idempotencyKey=idempotency_key,
            submissionOrigin=origin)))
        return
    await _steer_notice(server, target_session_ref, session, intent, prompt, claim, dict(
        waitForCompletion=False, ttlMs=KICKER_SUBMISSION_TTL_MS, submissionOrigin=origin))


NOTICE_PRINCIPAL = 'system:hrc-kicker'


async def _enqueue_notice(server, target_session_ref, session, intent, prompt, claim, options):
    try:
        body = await server.port.enqueue(session, intent, prompt, options)
    except asyncio.CancelledError:
        _release(server, target_session_ref, claim, wake=False)
        raise
    except Exception as error:
        _settle_failed(server, target_session_ref, claim, error_text(error))
        return
    if body.get('status') != 'started':
        exhausted = claim['attempts'] >= FAILURE_NOTICE_MAX_ATTEMPTS
        server.mail_kicker_failure_notice_backoff[target_session_ref] = dict(
            key=claim['noticeSet'], parkedRuntimeId=claim['runtimeId'], exhausted=exhausted,
            attempts=claim['attempts'], nextAtMs=server.now_ms())
        server.log('WARN', 'wrkq.kicker.failure_notice_parked', dict(
            targetSessionRef=target_session_ref, runtimeId=claim['runtimeId'], envelopes=claim['envelopes'],
            attempts=claim['attempts'], door=claim['door'],
            reason='attempts_exhausted' if exhausted else 'replayed_non_start',
            **({} if 'status' not in body else {'status': body['status']})))
        _release(server, target_session_ref, claim)
        return
    _settle_delivered(server, target_session_ref, claim, {} if body.get('runId') is None else {'runId': body['runId']})


async def _steer_notice(server, target_session_ref, session, intent, prompt, claim, options):
    try:
        body = await server.port.steer(session, intent, prompt, options)
    except Exception as error:
        if is_definite_seat_rejection(error):
            _fall_back_to_enqueue(server, target_session_ref, claim, error_text(error), 'dispatch')
        else:
            _settle_failed(server, target_session_ref, claim, error_text(error))
        return
    if body.get('admission') == 'rejected':
        _fall_back_to_enqueue(server, target_session_ref, claim,
                              body.get('reason') if body.get('reason') is not None else 'no_submission_identity',
                              'admission')
        return
    if claim['submissionId'] is not None:
        return  # bound from admission.requested; it may already have landed
    submission_id = body.get('submissionId') if body.get('submissionId') is not None else body.get('inputId')
    if submission_id is None:
        _settle_failed(server, target_session_ref, claim, 'missing_submission_identity')
        return
    claim['submissionId'] = submission_id
    server.log('INFO', 'wrkq.kicker.failure_notice_admitted', dict(
        targetSessionRef=target_session_ref, runtimeId=claim['runtimeId'], envelopes=claim['envelopes'],
        door='steer', submissionId=submission_id))


def observe_failure_notice_landing(server, record):
    """Settle an outstanding notice steer from the broker stream: landed means
    delivered; a refusal proven `not_written` falls back to enqueue; any other
    refusal leaves the rows undelivered and backed off."""
    if record['type'] == 'admission.requested':
        _bind_admitted_notice(server, record)
        return
    if record['type'] != 'input.accepted' and record['type'] not in LANDED_TYPES and record['type'] not in REFUSED_TYPES:
        return
    payload = parse_payload(record)
    mid_turn_write = is_mid_turn_write(record['type'], payload)
    if record['type'] == 'input.accepted' and not mid_turn_write:
        return
    submission_id = None if payload is None else (
        payload.get('submissionId') if payload.get('submissionId') is not None else payload.get('inputId'))
    if not isinstance(submission_id, str):
        return
    found = next(((target, claim) for target, claim in server.mail_kicker_failure_notice_outstanding.items()
                  if claim['door'] == 'steer' and claim['submissionId'] == submission_id), None)
    if found is None:
        return
    target_session_ref, claim = found
    if mid_turn_write or record['type'] in LANDED_TYPES:
        _settle_delivered(server, target_session_ref, claim, dict(submissionId=submission_id, landedOn=record['type']))
        return
    reason = payload['reason'] if isinstance(payload.get('reason'), str) else record['type']
    if payload.get('deliveryEvidence') == 'not_written':
        _fall_back_to_enqueue(server, target_session_ref, claim, reason, 'landing')
        return
    _settle_failed(server, target_session_ref, claim, reason)


def _bind_admitted_notice(server, record):
    """A landing can reach the stream before HRC's steer answer: bind the
    submission from its admission, as mail binds by envelope."""
    payload = parse_payload(record)
    origin = None if payload is None else payload.get('origin')
    submission_id = None if payload is None else payload.get('submissionId')
    if (not is_record(origin) or origin.get('principalRef') != NOTICE_PRINCIPAL or not isinstance(submission_id, str)
            or payload.get('class') not in (None, 'steer')):
        return
    for claim in server.mail_kicker_failure_notice_outstanding.values():
        if claim['door'] == 'steer' and claim['submissionId'] is None and claim['runtimeId'] == record['runtimeId']:
            claim['submissionId'] = submission_id
            return


def release_failure_notices_for_runtime(server, runtime_id):
    """A terminated runtime lands nothing more: its outstanding notice steer is
    released unlanded and uncharged; the rows wait for a live generation."""
    for target_session_ref, claim in list(server.mail_kicker_failure_notice_outstanding.items()):
        if claim['door'] == 'steer' and claim['runtimeId'] == runtime_id:
            _release(server, target_session_ref, claim)


def _settle_delivered(server, target_session_ref, claim, detail):
    server.mail_kicker_failure_notice_backoff.pop(target_session_ref, None)
    server.mail_kicker_failure_notice_steer_fallback.discard(claim['noticeSet'])
    server.store.mail_delivery.mark_failure_notices_delivered(target_session_ref, claim['envelopes'])
    server.log('INFO', 'wrkq.kicker.failure_notice_delivered', dict(
        targetSessionRef=target_session_ref, **detail, envelopes=claim['envelopes'], door=claim['door']))
    _release(server, target_session_ref, claim)


def _settle_failed(server, target_session_ref, claim, error):
    attempts = claim['attempts']
    exhausted = attempts >= FAILURE_NOTICE_MAX_ATTEMPTS
    delay_ms = 0 if attempts == 1 else min(
        FAILURE_NOTICE_BACKOFF_BASE_MS * 2 ** (attempts - 2), FAILURE_NOTICE_BACKOFF_MAX_MS)
    server.mail_kicker_failure_notice_backoff[target_session_ref] = dict(
        key=claim['noticeSet'], exhausted=exhausted, attempts=attempts, nextAtMs=server.now_ms() + delay_ms)
    if exhausted:
        server.log('WARN', 'wrkq.kicker.failure_notice_parked', dict(
            targetSessionRef=target_session_ref, runtimeId=claim['runtimeId'], envelopes=claim['envelopes'],
            attempts=attempts, door=claim['door'], reason='attempts_exhausted', error=error))
    else:
        server.log('WARN', 'wrkq.kicker.failure_notice_failed', dict(
            targetSessionRef=target_session_ref, runtimeId=claim['runtimeId'], envelopes=claim['envelopes'],
            attempt=attempts, door=claim['door'], nextAttemptInMs=delay_ms, error=error))
    _release(server, target_session_ref, claim)


def _fall_back_to_enqueue(server, target_session_ref, claim, reason, phase):
    server.mail_kicker_failure_notice_steer_fallback.add(claim['noticeSet'])
    server.log('WARN', 'wrkq.kicker.failure_notice_steer_refused', dict(
        targetSessionRef=target_session_ref, runtimeId=claim['runtimeId'], envelopes=claim['envelopes'],
        door='steer', reason=reason, phase=phase, fallbackDoor='enqueue',
        **({} if claim['submissionId'] is None else {'submissionId': claim['submissionId']})))
    _release(server, target_session_ref, claim)
    server.wake(target_session_ref, 'insert')


def _release(server, target_session_ref, claim, wake=True):
    """End the target's outstanding submission; wake it once if rows queued
    meanwhile still wait."""
    if server.mail_kicker_failure_notice_outstanding.get(target_session_ref) is claim:
        server.mail_kicker_failure_notice_outstanding.pop(target_session_ref, None)
    if not wake:
        return
    covered = set(claim['envelopes'])
    if any(notice.envelope_id not in covered
           for notice in server.store.mail_delivery.list_undelivered_failure_notices(target_session_ref)):
        server.wake(target_session_ref, 'insert')


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
        parsed = _js_json_parse(raw)
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
