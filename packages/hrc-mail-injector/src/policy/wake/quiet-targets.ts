/**
 * Quiet periodic targets (T-11680).
 *
 * The periodic sweep has two kinds of candidate. A target with pending mail in
 * the ledger view, or a due reminder, has outstanding business and is driven
 * on every sweep. A target held only by LOCAL state — an open delivery intent
 * or an undelivered failure notice — has nothing new to do until that state
 * changes: the intent is resolved by reconcile, not by a drive, and a notice
 * rides the next live generation. Driving every such target every sweep cost
 * three HRC reads apiece and ended `empty` every time.
 *
 * So a local-state target whose last periodic drive ended empty is skipped
 * while its fingerprint is unchanged. The fingerprint is deliberately blind to
 * timestamps: reconcile rewrites `updated_at` on every open intent each pass.
 * Event-driven wakes never consult this; a failure-notice backoff coming due
 * and the backstop both re-drive.
 */
import type { MailKickerContext } from '../context.js'
import type { DriveMailTargetOutcome } from '../drive/target-driver.js'
import { PERIODIC_QUIET_BACKSTOP_MS } from '../internal.js'

/** The local state a periodic drive of `targetSessionRef` depends on. */
export function periodicTargetFingerprint(
  server: MailKickerContext,
  targetSessionRef: string,
  seated: ReadonlySet<string>
): string {
  const intents = server.store.mailDelivery
    .listOpenIntents(targetSessionRef)
    .map((intent) =>
      [
        intent.envelopeId,
        intent.runtimeId,
        intent.submissionId,
        intent.uncertainCause,
        intent.lastEvidenceKind,
        intent.cleanupOutcome,
      ].join('|')
    )
    .sort()
  const notices = server.store.mailDelivery
    .listUndeliveredFailureNotices(targetSessionRef)
    .map((notice) => notice.envelopeId)
    .sort()
  return JSON.stringify({ seated: seated.has(targetSessionRef), intents, notices })
}

/**
 * Which local-state targets this sweep drives. Every one it returns gets an
 * unconfirmed memo entry, which `recordPeriodicDrive` confirms if the drive
 * finds nothing; entries for targets that left the candidate set are pruned.
 */
export function selectChangedPeriodicTargets(
  server: MailKickerContext,
  candidates: ReadonlySet<string>,
  seated: ReadonlySet<string>,
  nowMs: number = Date.now()
): string[] {
  for (const targetSessionRef of server.mailKickerQuietTargets.keys()) {
    if (!candidates.has(targetSessionRef)) server.mailKickerQuietTargets.delete(targetSessionRef)
  }
  const selected: string[] = []
  for (const targetSessionRef of candidates) {
    const fingerprint = periodicTargetFingerprint(server, targetSessionRef, seated)
    const quiet = server.mailKickerQuietTargets.get(targetSessionRef)
    if (
      quiet?.confirmed === true &&
      quiet.fingerprint === fingerprint &&
      nowMs - quiet.quietSinceMs < PERIODIC_QUIET_BACKSTOP_MS &&
      !failureNoticeBackoffDue(server, targetSessionRef, nowMs)
    ) {
      continue
    }
    server.mailKickerQuietTargets.set(targetSessionRef, {
      fingerprint,
      quietSinceMs: nowMs,
      confirmed: false,
    })
    selected.push(targetSessionRef)
  }
  return selected
}

/** Confirm a periodic drive that found nothing; anything else is not quiet. */
export function recordPeriodicDrive(
  server: MailKickerContext,
  targetSessionRef: string,
  outcome: DriveMailTargetOutcome
): void {
  const quiet = server.mailKickerQuietTargets.get(targetSessionRef)
  if (quiet === undefined) return
  if (outcome?.outcome === 'empty') quiet.confirmed = true
  else server.mailKickerQuietTargets.delete(targetSessionRef)
}

function failureNoticeBackoffDue(
  server: MailKickerContext,
  targetSessionRef: string,
  nowMs: number
): boolean {
  const backoff = server.mailKickerFailureNoticeBackoff.get(targetSessionRef)
  return (
    backoff !== undefined &&
    !backoff.exhausted &&
    backoff.parkedRuntimeId === undefined &&
    backoff.nextAtMs <= nowMs
  )
}
