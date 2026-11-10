import type { HrcMailDeliveryIntent } from 'hrc-injector-core'
import type { MailKickerContext } from '../context.js'
import {
  BIRTH_SWEEP_BACKOFF_BASE_MS,
  PARTICIPANT_HOST_FIRST_RETRY_MS,
  parseSessionRef,
} from '../internal.js'
import { failEnvelopeWithAudit } from '../terminal/envelope-terminal.js'

/** The launch bound belongs to the envelope, independently of scope backoff. */
export async function failExhaustedLaunch(
  server: MailKickerContext,
  envelopeId: string,
  targetSessionRef: string
): Promise<boolean> {
  const failure = server.store.launchFailures.get(envelopeId)
  if (failure === undefined || failure.attempts < 3) return false
  const row = await server.ledger.envelopeShow({ envelope: envelopeId })
  if (!row.terminal && row.state === 'pending' && row.presentedTo.length === 0) {
    await failEnvelopeWithAudit(server, {
      envelope: envelopeId,
      targetSessionRef,
      reason: 'undeliverable',
      detail: `birth_failed: ${failure.lastError}`,
      callSite: 'launch_birth_exhausted',
    })
  }
  return true
}

/**
 * Release only a launch intent; broker submission uncertainty keeps its fence.
 *
 * `participantHost` is the typed reason when HRC refused because the address's
 * participant host is not serving (T-13151): its first retry is short, because
 * HRC knocked the host in the same refusal. Later attempts keep the ordinary
 * doubling, so the envelope's three-attempt launch bound still spans minutes.
 */
export async function recoverFailedLaunch(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent,
  error: string,
  participantHost?: { reason: string }
): Promise<void> {
  const current = server.store.mailDelivery.getIntent(intent.envelopeId)
  if (current?.presentationId !== intent.presentationId || current.door !== 'launch') return
  const row = await server.ledger.envelopeShow({ envelope: intent.envelopeId })
  // A landing or sender disposal that raced the failed RPC owns the envelope.
  if (row.terminal || row.state !== 'pending' || row.presentedTo.length > 0) return
  // The ledger read yields: a live observer may have closed or replaced it.
  if (
    server.store.mailDelivery.getIntent(intent.envelopeId)?.presentationId !== intent.presentationId
  )
    return
  const attempts = server.store.launchFailures.record(
    intent.envelopeId,
    intent.presentationId,
    error
  )
  server.store.mailDelivery.recordBirthRefusal({
    targetSessionRef: intent.targetSessionRef,
    scopeRef: parseSessionRef(intent.targetSessionRef).scopeRef,
    reason: error,
  })
  server.store.mailDelivery.clearIntent(intent.envelopeId)
  server.mailKickerStalledDeliveryAnnounced.delete(intent.envelopeId)
  const nextAttemptInMs =
    participantHost !== undefined && attempts === 1
      ? PARTICIPANT_HOST_FIRST_RETRY_MS
      : BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1)
  server.mailKickerBirthSweepBackoff.set(intent.targetSessionRef, {
    attempts,
    nextAtMs: Date.now() + nextAttemptInMs,
  })
  server.log('WARN', 'wrkq.kicker.launch_birth_released', {
    envelope: intent.envelopeId,
    targetSessionRef: intent.targetSessionRef,
    presentationId: intent.presentationId,
    attempts,
    error,
    ...(participantHost === undefined ? {} : { participantHostRefusal: participantHost.reason }),
    nextAttemptInMs,
  })
  await failExhaustedLaunch(server, intent.envelopeId, intent.targetSessionRef)
}
