export async function deliverFailureNotices(
  server: MailKickerContext,
  targetSessionRef: string,
  session: HrcSessionRecord
): Promise<void> {
  const notices = server.store.mailDelivery.listUndeliveredFailureNotices(targetSessionRef)
  if (notices.length === 0) {
    server.mailKickerFailureNoticeBackoff.delete(targetSessionRef)
    return
  }
  const envelopes = notices.map((notice) => notice.envelopeId).sort()
  // Backoff belongs to the notice set, never to a runtime: a key that hashed in
  // the runtime reset on every reseat, and enqueueing into a seatless session
  // reseated it every pass (T-11970: attempt 1, delay 0, a codex birth every
  // ~31s). A newly owed notice is a different set and starts clean.
  const noticeSet = createHash('sha256')
    .update(targetSessionRef)
    .update('\0')
    .update(envelopes.join('\0'))
    .digest('hex')
  let backoff = server.mailKickerFailureNoticeBackoff.get(targetSessionRef)
  if (backoff !== undefined && backoff.key !== noticeSet) {
    server.mailKickerFailureNoticeBackoff.delete(targetSessionRef)
    backoff = undefined
  }
  if (backoff !== undefined && (backoff.exhausted || backoff.nextAtMs > Date.now())) return
  // A notice rides a seat that is already live and NEVER summons one, the same
  // rule as fyi. HRC's enqueue provisions a runtime for a seatless session, so
  // the gate is the broker's own answer, not a runtime row: a row whose broker
  // never came up is not a seat. Otherwise the notice stays owed and a sender
  // that comes back gets it then.
  const seat = await observeBrokerSeat(server, session)
  if (seat.state !== 'idle' && seat.state !== 'turn-active') return
  const runtimeId = seat.runtimeId
  // A replayed non-start is an answer about that runtime only.
  if (backoff?.parkedRuntimeId === runtimeId) return
  const intent =
    session.lastAppliedIntentJson ??
    (await server.port.resolveRuntimeIntent(parseSessionRef(targetSessionRef).scopeRef, undefined))
  if (intent === undefined) return
  const prompt = notices.map((notice) => notice.notice).join('\n\n')
  // The dispatch response can time out after HRC has accepted the prompt. A
  // stable key turns the next sweep into a read/replay of that admission,
  // rather than another user message. Include the complete notice set so a
  // later, newly owed notice gets its own dispatch. Include the runtime so a
  // reseated sender is offered the notice again rather than a replay of the
  // old seat's terminal answer.
  const idempotencyKey = `hrc-mail-failure-notice-${createHash('sha256')
    .update(targetSessionRef)
    .update('\0')
    .update(runtimeId)
    .update('\0')
    .update(envelopes.join('\0'))
    .digest('hex')}`
  const attempts = (backoff?.attempts ?? 0) + 1
  const exhausted = attempts >= FAILURE_NOTICE_MAX_ATTEMPTS
  try {
    const body = await server.port.enqueue(session, intent, prompt, {
      waitForCompletion: false,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      idempotencyKey,
      submissionOrigin: { principalRef: 'system:hrc-kicker', scopeRef: session.scopeRef },
    })
    if (body.status !== 'started') {
      // This key now replays the same answer on every call, so asking again
      // on this runtime cannot deliver anything. A sender that reseats may be
      // asked again, within the same attempt budget.
      server.mailKickerFailureNoticeBackoff.set(targetSessionRef, {
        key: noticeSet,
        parkedRuntimeId: runtimeId,
        exhausted,
        attempts,
        nextAtMs: Date.now(),
      })
      server.log('WARN', 'wrkq.kicker.failure_notice_parked', {
        targetSessionRef,
        runtimeId,
        envelopes,
        attempts,
        reason: exhausted ? 'attempts_exhausted' : 'replayed_non_start',
        status: body.status,
      })
      return
    }
    server.mailKickerFailureNoticeBackoff.delete(targetSessionRef)
    server.store.mailDelivery.markFailureNoticesDelivered(targetSessionRef, envelopes)
    server.log('INFO', 'wrkq.kicker.failure_notice_delivered', {
      targetSessionRef,
      runId: body.runId,
      envelopes,
    })
  } catch (error) {
    // Nothing is marked delivered: a notice that could not be shown is not a
    // notice that stops being owed. The first retry is immediate, because a
    // lost response replays its stable key; later refusals back off, and the
    // budget ends in a park rather than a retry forever.
    const delayMs =
      attempts === 1
        ? 0
        : Math.min(
            FAILURE_NOTICE_BACKOFF_BASE_MS * 2 ** (attempts - 2),
            FAILURE_NOTICE_BACKOFF_MAX_MS
          )
    server.mailKickerFailureNoticeBackoff.set(targetSessionRef, {
      key: noticeSet,
      exhausted,
      attempts,
      nextAtMs: Date.now() + delayMs,
    })
    if (exhausted) {
      server.log('WARN', 'wrkq.kicker.failure_notice_parked', {
        targetSessionRef,
        runtimeId,
        envelopes,
        attempts,
        reason: 'attempts_exhausted',
        error: errorText(error),
      })
      return
    }
    server.log('WARN', 'wrkq.kicker.failure_notice_failed', {
      targetSessionRef,
      runtimeId,
      envelopes,
      attempt: attempts,
      nextAttemptInMs: delayMs,
      error: errorText(error),
    })
  }
}

/**
 * §5 — queue the sender-side notice for one `envelope.failed` off the tail.
 *
 * Rendered by reading the ROW back, not from the event payload: the real
 * payload carries `{state, reason, room_uuid, runtime_id, detail?}` and neither
 * party nor the room key (paired against wrkqd at wrkq 88b133a; `detail` since
 * wrkq b067eb8, T-09657). The envelope id is on the event row itself.
 *
 * Only a sender this node homes or seats is served. A notice is delivered by
 * exactly one daemon — the sender's own — and a human sender is served by the
 * ACP surfaces instead (§11), never by a summon here.
 *
 * Only a failed `reply_required` earns a notice (T-09880). A fyi or notify
 * carries no obligation; undeliverable-to-an-ended-seat is its designed
 * outcome, so there is nothing to resend or escalate.
 */
export async function queueFailureNotice(
  server: MailKickerContext,
  event: WrkqMonitorEvent
): Promise<void> {
  const envelopeId = event.resourceId
  if (envelopeId === undefined) return
  const reason = failureReasonFor(event.payload)
  if (reason === undefined) return
  const envelope = await server.ledger.envelopeShow({ envelope: envelopeId })
  if (envelope.obligation !== 'reply_required') return
  const senderScope = envelope.from.scopeRef
  if (senderScope === undefined) return
  const targetSessionRef = targetSessionRefForLedgerScope(senderScope)
  if (targetSessionRef === undefined) return
  // The placement ledger is keyed on the CANONICAL scope, not on the handle
  // wrkq stores. Handing it the handle throws rather than missing, which is how
  // one un-normalized read took the whole notice path down.
  const canonicalScope = kickerScopeRefFor(targetSessionRef)
  const bindings = await server.port.localPlacementBindings()
  const homed = bindings.bindings.some(
    (binding) =>
      binding.scopeRef === canonicalScope &&
      binding.state === 'active' &&
      binding.homeNodeId === server.nodeId
  )
  if (!homed && (await server.port.targetBySessionRef(targetSessionRef)) === undefined) return
  const payload = failedPayload(event.payload)
  const runtimeId = payload?.runtime_id
  const detail = typeof payload?.detail === 'string' ? payload.detail : undefined
  const notice = formatEnvelopeFailureNotice(envelope, reason, {
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(detail === undefined ? {} : { detail }),
  })
  if (!server.store.mailDelivery.recordFailureNotice({ envelopeId, targetSessionRef, notice }))
    return
  server.log('INFO', 'wrkq.kicker.failure_notice_queued', {
    targetSessionRef,
    envelope: envelopeId,
    reason,
  })
  server.wake(targetSessionRef, 'insert')
}

function failedPayload(raw: string | undefined): WrkqEnvelopeFailedPayload | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? (parsed as WrkqEnvelopeFailedPayload) : undefined
}

const FAILURE_REASONS = new Set<WrkqEnvelopeFailureReason>([
  'runtime_terminated',
  'ignored',
  'undeliverable',
  'legacy',
])

function failureReasonFor(raw: string | undefined): WrkqEnvelopeFailureReason | undefined {
  const reason = failedPayload(raw)?.reason
  if (reason === undefined) return undefined
  return FAILURE_REASONS.has(reason as WrkqEnvelopeFailureReason)
    ? (reason as WrkqEnvelopeFailureReason)
    : undefined
}
import type { HrcSessionRecord } from 'hrc-core'

import { createHash } from 'node:crypto'
import type { MailKickerContext } from '../context.js'
import { kickerScopeRefFor } from '../drive/authority.js'
import { observeBrokerSeat } from '../drive/seat.js'
import {
  FAILURE_NOTICE_BACKOFF_BASE_MS,
  FAILURE_NOTICE_BACKOFF_MAX_MS,
  FAILURE_NOTICE_MAX_ATTEMPTS,
  KICKER_SUBMISSION_TTL_MS,
  errorText,
  isRecord,
  parseSessionRef,
} from '../internal.js'
import { formatEnvelopeFailureNotice } from '../ledger/presentation.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import type {
  WrkqEnvelopeFailedPayload,
  WrkqEnvelopeFailureReason,
  WrkqMonitorEvent,
} from '../ledger/types.js'
