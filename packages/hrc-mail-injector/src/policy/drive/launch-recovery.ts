import type { HrcMailDeliveryIntent } from 'hrc-injector-core'
import type { MailKickerContext } from '../context.js'
import {
  BIRTH_SWEEP_BACKOFF_BASE_MS,
  PARTICIPANT_HOST_GIVE_UP_MS,
  parseSessionRef,
  participantHostRetryInMs,
} from '../internal.js'
import { failEnvelopeWithAudit } from '../terminal/envelope-terminal.js'

/**
 * The launch bound belongs to the envelope, independently of scope backoff.
 * Three attempts, except while every refusal has been the participant-host
 * class (T-13151): then ten minutes from the first refusal, because a parked
 * host can take that long to rejoin and each refusal knocks it again.
 */
export async function failExhaustedLaunch(
  server: MailKickerContext,
  envelopeId: string,
  targetSessionRef: string
): Promise<boolean> {
  const failure = server.store.launchFailures.get(envelopeId)
  if (failure === undefined) return false
  const exhausted =
    failure.participantHostSinceMs === undefined
      ? failure.attempts >= 3
      : Date.now() - failure.participantHostSinceMs >= PARTICIPANT_HOST_GIVE_UP_MS
  if (!exhausted) return false
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
 * participant host is not serving (T-13151). HRC knocked the host in the same
 * refusal, so retries run at 10 s, 20 s, 40 s, then every minute, and the
 * envelope's bound is ten minutes from the first such refusal.
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
    error,
    participantHost === undefined ? undefined : Date.now()
  )
  server.store.mailDelivery.recordBirthRefusal({
    targetSessionRef: intent.targetSessionRef,
    scopeRef: parseSessionRef(intent.targetSessionRef).scopeRef,
    reason: error,
  })
  server.store.mailDelivery.clearIntent(intent.envelopeId)
  server.mailKickerStalledDeliveryAnnounced.delete(intent.envelopeId)
  const nextAttemptInMs =
    participantHost === undefined
      ? BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1)
      : participantHostRetryInMs(attempts)
  server.mailKickerBirthSweepBackoff.set(intent.targetSessionRef, {
    attempts,
    nextAtMs: Date.now() + nextAttemptInMs,
    ...(participantHost === undefined ? {} : { participantHost: true as const }),
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
