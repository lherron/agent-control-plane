/**
 * A backlog digest's members, found again from any one of them (T-10159).
 *
 * The digest is ONE submission carrying N envelopes, but HRC's delivery fence is
 * one intent row PER ENVELOPE and its `form` column is closed to the three
 * per-envelope forms. Neither changes: each member keeps its own intent (store
 * form `full`) and its own presentation id, and the GROUP is carried in that id,
 * which is opaque to HRC and to wrkq alike:
 *
 *   present-digest-<groupUuid>-<EN-id>
 *
 * Every member id stays unique, so wrkq's per-presentation dedupe still holds,
 * and a landing, refusal or reconcile that reaches one member can reach the
 * rest without any new column.
 */
import type { HrcMailDeliveryIntent } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'

const DIGEST_PREFIX = 'present-digest-'
const UUID_LENGTH = 36

export function digestPresentationId(groupId: string, envelopeId: string): string {
  return `${DIGEST_PREFIX}${groupId}-${envelopeId}`
}

/** The digest group this presentation id belongs to, if it is a digest member. */
export function digestGroupOf(presentationId: string): string | undefined {
  if (!presentationId.startsWith(DIGEST_PREFIX)) return undefined
  const group = presentationId.slice(DIGEST_PREFIX.length, DIGEST_PREFIX.length + UUID_LENGTH)
  return group.length === UUID_LENGTH ? group : undefined
}

/**
 * Every OPEN intent delivered in the same submission as this one, itself
 * included and first. A non-digest intent is its own whole group.
 *
 * Terminal members are returned too: a member acked while the digest was queued
 * still needs its late landing recorded as audit-only.
 */
export function digestMembers(
  server: MailKickerContext,
  intent: HrcMailDeliveryIntent
): HrcMailDeliveryIntent[] {
  const group = digestGroupOf(intent.presentationId)
  if (group === undefined) return [intent]
  const siblings = server.store.mailDelivery
    .listOpenIntents(intent.targetSessionRef)
    .filter(
      (candidate) =>
        candidate.envelopeId !== intent.envelopeId &&
        digestGroupOf(candidate.presentationId) === group
    )
  return [intent, ...siblings]
}
