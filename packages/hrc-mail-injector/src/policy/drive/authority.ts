/**
 * The runtime a presentation receipt must name: the host session's CURRENT
 * seat, not the oldest row it ever had (T-07650 mechanism A).
 *
 * The previous expression was `listByHostSessionId(...).find(r => r.status !==
 * 'exited')`. That query is `ORDER BY created_at ASC`, and `'exited'` is an
 * `HrcBrokerInvocationState`, never a runtime status — no stored row has ever
 * held it, so the predicate excluded nothing and the expression was `[0]`: the
 * FIRST runtime the host session ever had, whatever became of it. A receipt
 * therefore named a five-week-old row while the turn ran on the current one, in
 * proportion to how long the session had lived and not to anything being wrong.
 * The audits found it fleet-wide with zero true corpses behind it — max3 60/60,
 * svc 38/38, every one resolving to a live host session.
 *
 * Newest-first, skipping the unavailable states, and pinned to the SESSION'S
 * GENERATION so a prior-generation runtime left `ready` after a rotation can
 * never be named (T-07650, on Lance's max3 specimen: gen 27 `ready` since
 * 17:00Z took a message meant for gen 50). No current-generation seat means NO
 * runtimeId: a delivery with no runtime is refused honestly, while one naming
 * the wrong runtime is not recoverable after the fact.
 */
export async function presentationRuntimeIdFor(
  server: MailKickerContext,
  session: HrcSessionRecord
): Promise<string | undefined> {
  const runtimes = await server.port.runtimesByHostSession(session.hostSessionId)
  for (let index = runtimes.length - 1; index >= 0; index -= 1) {
    const runtime = runtimes[index]
    if (runtime === undefined) continue
    if (runtime.generation !== session.generation) continue
    if (runtime.status === 'exited' || isRuntimeUnavailableStatus(runtime.status)) continue
    return runtime.runtimeId
  }
  return undefined
}

/** The scope behind a drive target, or nothing when the ref is unparseable. */
export function kickerScopeRefFor(targetSessionRef: string): string | undefined {
  try {
    return parseSessionRef(targetSessionRef).scopeRef
  } catch {
    return undefined
  }
}

/**
 * Skip a foreign-homed target: ONE positive line per scope per epoch.
 *
 * The line is written once — a skip repeated every tick is noise — and any
 * birth this node still believes it owes is RESOLVED, because a scope homed
 * elsewhere is not this node's to birth and would otherwise re-enter the
 * sweep's candidate set on every tick for the life of the store.
 *
 * Stale local RUNTIMES are deliberately NOT torn down here. Evicting a live
 * seat is an operator retirement decision, never a delivery mechanism's; a
 * routing verdict must not kill a session an operator may be attached to.
 */
export function skipForeignHomedTarget(
  server: MailKickerContext,
  targetSessionRef: string,
  scopeRef: string,
  foreign: ForeignHome,
  wakeReason: HrcMailDriveWakeReason
): void {
  const resolvedBirth = server.store.mailDelivery.resolveBirthRefusal(
    targetSessionRef,
    `${scopeRef} is homed on ${foreign.homeNodeId}; this node has no authority to drive it`
  )
  server.mailKickerBirthSweepBackoff.delete(targetSessionRef)

  // Announcement is deduped on its OWN map, not on the resolver's memo. The
  // memo is shared with the shadow teardown, and whichever mechanism happened
  // to resolve the scope first would otherwise silence this line for the other.
  const announcement = foreign.homeNodeId
  const alreadyAnnounced = server.mailKickerForeignHomeAnnounced.get(scopeRef) === announcement
  server.mailKickerForeignHomeAnnounced.set(scopeRef, announcement)
  if (alreadyAnnounced && !resolvedBirth) return

  server.log('INFO', 'wrkq.kicker.foreign_home_skipped', {
    targetSessionRef,
    scopeRef,
    homeNodeId: foreign.homeNodeId,
    source: foreign.source,
    wakeReason,
    resolvedBirthRefusal: resolvedBirth,
  })
}

/**
 * A gate refusal that is a BIRTH DEFERRAL rather than a delivery failure (T-07655).
 *
 * Two reasons qualify, and both mean the same thing operationally: this node
 * takes no part in the birth, and there is nothing wrong with it or with the
 * mail. Before this existed they fell into the generic catch and printed
 * `drive_failed`, which is how three nodes racing for one birth looked like
 * three broken drives.
 */
type BirthDeferral = {
  reason:
    | 'birth-designated-elsewhere'
    | 'designated-home-unreachable'
    | 'birth-designation-mismatch'
  homeNodeId: string
  designationEpoch: number
  birthEnvelopeId: string
  senderScopeRef: string
  provenance: string
}

export function birthDeferralFor(error: unknown): BirthDeferral | undefined {
  if (!(error instanceof HrcDomainError)) return undefined
  const reason = error.detail['reason']
  if (
    reason !== 'birth-designated-elsewhere' &&
    reason !== 'designated-home-unreachable' &&
    reason !== 'birth-designation-mismatch'
  ) {
    return undefined
  }
  const designation = error.detail['birthDesignation']
  if (!isRecord(designation)) return undefined
  const homeNodeId = designation['homeNodeId']
  const designationEpoch = designation['designationEpoch']
  const birthEnvelopeId = designation['birthEnvelopeId']
  const senderScopeRef = designation['senderScopeRef']
  const provenance = designation['provenance']
  if (
    typeof homeNodeId !== 'string' ||
    typeof designationEpoch !== 'number' ||
    typeof birthEnvelopeId !== 'string' ||
    typeof senderScopeRef !== 'string' ||
    typeof provenance !== 'string'
  ) {
    return undefined
  }
  return { reason, homeNodeId, designationEpoch, birthEnvelopeId, senderScopeRef, provenance }
}

/** Resolve a deferred birth and say so ONCE per scope per designation epoch. */
export function deferBirthForTarget(
  server: MailKickerContext,
  targetSessionRef: string,
  scopeRef: string,
  deferral: BirthDeferral,
  wakeReason: HrcMailDriveWakeReason
): void {
  const resolvedBirth = server.store.mailDelivery.resolveBirthRefusal(
    targetSessionRef,
    `${scopeRef} is designated to be born on ${deferral.homeNodeId}; this node takes no part in the birth`
  )
  server.mailKickerBirthSweepBackoff.delete(targetSessionRef)

  const announcement = `${deferral.homeNodeId}@${deferral.designationEpoch}`
  const alreadyAnnounced = server.mailKickerBirthDeferredAnnounced.get(scopeRef) === announcement
  server.mailKickerBirthDeferredAnnounced.set(scopeRef, announcement)
  if (alreadyAnnounced) return

  server.log('INFO', 'wrkq.kicker.birth_deferred', {
    targetSessionRef,
    scopeRef,
    birthEnvelopeId: deferral.birthEnvelopeId,
    senderScopeRef: deferral.senderScopeRef,
    homeNodeId: deferral.homeNodeId,
    provenance: deferral.provenance,
    designationEpoch: deferral.designationEpoch,
    reason: deferral.reason,
    wakeReason,
    resolvedBirthRefusal: resolvedBirth,
  })
}

/**
 * A birth refusal that no retry can change (T-09657).
 *
 * HRC types a caller-fixable placement fact — a task-named worktree whose
 * branch names another task, an invalid project target or agent profile — as
 * 422 `declaration_invalid`. Nothing about the target changes between sweeps,
 * so charging it as one more transient strike only delays the sender's notice
 * by the whole D7 backoff. Keyed on the typed code, never on message text.
 */
export type DeterministicBirthRefusal = {
  code: string
  message: string
  source?: string | undefined
}

export function deterministicBirthRefusalFor(
  error: unknown
): DeterministicBirthRefusal | undefined {
  if (!(error instanceof HrcDomainError)) return undefined
  if (error.code !== HrcErrorCode.DECLARATION_INVALID) return undefined
  if (localPlacementRefusalFor(error) !== undefined) return undefined
  const source = error.detail['source']
  return {
    code: error.code,
    message: error.message,
    ...(typeof source === 'string' ? { source } : {}),
  }
}

import { homedir } from 'node:os'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcSessionRecord } from 'hrc-core'
import type { HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { ForeignHome } from '../contracts.js'
import { isRecord, isRuntimeUnavailableStatus, parseSessionRef } from '../internal.js'

/**
 * A birth refusal that is a fact about THIS node, not about the declaration
 * (T-09822).
 *
 * HRC types a project root this node cannot resolve to a canonical checkout —
 * the registered root is missing here, is a linked worktree, or no marker scan
 * found one — as `declaration_invalid` with `source: project-targets`. Every
 * node's injector drives the same ledger, so for a scope nobody has bound yet
 * the node WITHOUT the checkout often reaches the envelope first; failing it
 * there let the race decide the mail's fate. Such a node leaves the envelope to
 * a node that can host the project. If none can, the ordinary D7 bound fails it
 * with this reason: the refusal row and the backoff are this node's own, so it
 * never delays another node's birth, and `failUndeliverableMail` re-locates
 * first, so a scope another node has bound is never failed from here.
 */
export type LocalPlacementRefusal = {
  source: string
  message: string
  home: string
  projectId?: string | undefined
  projectRoot?: string | undefined
}

export function localPlacementRefusalFor(error: unknown): LocalPlacementRefusal | undefined {
  if (!(error instanceof HrcDomainError)) return undefined
  if (error.code !== HrcErrorCode.DECLARATION_INVALID) return undefined
  const source = error.detail['source']
  if (source !== 'project-targets') return undefined
  const home = error.detail['home']
  const projectId = error.detail['projectId']
  const projectRoot = error.detail['projectRoot']
  return {
    source,
    message: error.message,
    home: typeof home === 'string' ? home : (process.env['HOME'] ?? homedir()),
    ...(typeof projectId === 'string' ? { projectId } : {}),
    ...(typeof projectRoot === 'string' ? { projectRoot } : {}),
  }
}
