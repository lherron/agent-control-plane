import { randomUUID } from 'node:crypto'
/**
 * One pass of delivery policy for one target (spec T-08092 rev 4, D2).
 *
 * The shape is: read the pending view, probe the seat, then deliver each
 * actionable envelope through its own door as its own submission. There is no
 * drive slot, no held batch and no attempt: the OUTSTANDING INTENT SET replaces
 * every "already delivering" guard, because it is durable and a slot was not.
 *
 * Routing, per envelope, in ledger order:
 *
 *  - `delivery = hold` → preempt, under the existing operator-authority gate;
 *    refused authority falls into the queue policy below and the eventual
 *    receipt carries `hold_refused_authority`;
 *  - seat idle or turn-active AND the driver advertises `steer` → the steer
 *    door (T-08533: steer = send now): the body joins the turn the reader is
 *    already in, or starts one on an idle seat;
 *  - a steer refused unwritten by a guarded turn, authority or capability →
 *    that envelope's next pass takes enqueue, queued behind the turn;
 *  - driver without steer, or a runtime that refused it at the capability
 *    layer → enqueue, and the harness-local queue drains it at the boundary;
 *  - seat absent → cold birth, and the launch carries the body.
 *
 */
import type { HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { errorText } from '../internal.js'
import { WrkqLedgerUnavailableError } from '../ledger/client.js'
import { deliverFailureNotices } from '../terminal/failure-notices.js'
import { failUndeliverableMail } from '../wake/birth-retry.js'
import {
  birthDeferralFor,
  deferBirthForTarget,
  deterministicBirthRefusalFor,
  kickerScopeRefFor,
  localPlacementRefusalFor,
  skipForeignHomedTarget,
} from './authority.js'
import { deliverByColdBirth, deliverDigestToSeat, deliverToSeat } from './delivery.js'
import type { ActionableEnvelope } from './presentation.js'
import { classifyBacklogFyi, readActionableEnvelopes, summonsATurn } from './presentation.js'
import type { ObservedBrokerSeat } from './seat.js'
import { observeBrokerSeat } from './seat.js'

export type DriveMailTargetOutcome =
  | { outcome: 'birth-refused'; notPlaceableHere?: true }
  | { outcome: 'undeliverable'; failed: number }
  | undefined

/**
 * Take the launch-carried door for a target with no live runtime.
 *
 * Shared by the two ways a target can have nothing seated: no session row at
 * all, and a session row whose seat the broker reports `absent`. They are the
 * same delivery problem — there is no harness to submit into — and routing only
 * the first one here is what let the second fall to `enqueue` and race the
 * launch's own priming prompt (T-08394).
 */
async function birthForTarget(
  server: MailKickerContext,
  targetSessionRef: string,
  scopeRef: string | undefined,
  actionable: readonly ActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason
): Promise<DriveMailTargetOutcome> {
  // A non-summoning envelope (a legacy `fyi`) never MINTS a session: a target
  // with no session row is not born for it, so a wake set holding nothing else
  // stops here. A seat-absent fyi whose session row already exists does not
  // reach this branch; when its target is driven (a fyi is never itself a wake
  // for a seatless target: see ledger-tail and the periodic sweep),
  // `driveMailTargetOnce` sends it through `deliverToSeat`, and that delivery MAY
  // birth a fresh runtime for the session (T-09643 ruling).
  const summons = actionable.find((item) => summonsATurn(item.envelope))
  if (summons === undefined) return
  try {
    const outcome = await deliverByColdBirth(server, targetSessionRef, summons, wakeReason)
    if (outcome === 'submitted' && actionable.length > 1) {
      // One launch carries one envelope; the rest are delivered by policy
      // once the seat is live.
      server.wake(targetSessionRef, wakeReason)
    }
    return
  } catch (error) {
    // A birth deferral is not a failed delivery. It is this node correctly
    // declining a birth the collective designated elsewhere, and reporting it
    // as a failure is what made the pre-T-07655 race look like breakage on
    // every node that lost it.
    const deferral = birthDeferralFor(error)
    if (deferral !== undefined && scopeRef !== undefined) {
      deferBirthForTarget(server, targetSessionRef, scopeRef, deferral, wakeReason)
      return
    }
    // This node cannot host the project (T-09822). Not a failed delivery and
    // not the sender's fault: leave the envelope to a node that can. The row
    // recorded below is the no-host backstop's only record.
    const local = localPlacementRefusalFor(error)
    if (local !== undefined) {
      server.log('INFO', 'wrkq.kicker.birth_not_placeable_here', {
        targetSessionRef,
        wakeReason,
        envelope: summons.envelope.id,
        nodeId: server.nodeId,
        home: local.home,
        ...(local.projectId === undefined ? {} : { projectId: local.projectId }),
        ...(local.projectRoot === undefined ? {} : { projectRoot: local.projectRoot }),
        source: local.source,
        message: local.message,
      })
      if (scopeRef !== undefined) {
        server.store.mailDelivery.recordBirthRefusal({
          targetSessionRef,
          scopeRef,
          reason: `no node seated ${scopeRef}; node ${server.nodeId} (HOME=${local.home}) cannot host it: ${local.message}`,
        })
      }
      return { outcome: 'birth-refused', notPlaceableHere: true }
    }
    server.log('WARN', 'wrkq.kicker.birth_failed', {
      targetSessionRef,
      wakeReason,
      envelope: summons.envelope.id,
      error: errorText(error),
    })
    if (scopeRef !== undefined) {
      server.store.mailDelivery.recordBirthRefusal({
        targetSessionRef,
        scopeRef,
        reason: errorText(error),
      })
    }
    // A caller-fixable refusal (T-09657) fails the summons NOW and tells the
    // sender why; retrying it only delays that by the whole D7 backoff. If the
    // fail cannot complete, the refusal row stays open and the ordinary backoff
    // still bounds it.
    const deterministic = deterministicBirthRefusalFor(error)
    if (deterministic !== undefined) {
      server.log('WARN', 'wrkq.kicker.birth_refusal_deterministic', {
        targetSessionRef,
        wakeReason,
        envelope: summons.envelope.id,
        code: deterministic.code,
        ...(deterministic.source === undefined ? {} : { source: deterministic.source }),
        message: deterministic.message,
      })
      try {
        const terminal = await failUndeliverableMail(server, targetSessionRef, {
          refusals: 1,
          callSite: 'birth_refused_deterministic',
          detail: `HRC refused the birth (${deterministic.code}): ${deterministic.message}`,
        })
        if (terminal !== undefined) {
          server.store.mailDelivery.resolveBirthRefusal(
            targetSessionRef,
            `deterministic birth refusal; pending mail failed undeliverable: ${deterministic.message}`
          )
          server.mailKickerBirthSweepBackoff.delete(targetSessionRef)
          return { outcome: 'undeliverable', failed: terminal.failed }
        }
      } catch (failError) {
        server.log('WARN', 'wrkq.kicker.undeliverable_failed', {
          targetSessionRef,
          error: errorText(failError),
        })
      }
    }
    return { outcome: 'birth-refused' }
  }
}

export async function driveMailTargetOnce(
  server: MailKickerContext,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason
): Promise<DriveMailTargetOutcome> {
  const driveAttemptId = `drive-${randomUUID()}`
  const startedAt = Date.now()
  const phase = (
    name: string,
    outcome: 'started' | 'ok' | 'failed' | 'skipped',
    detail: Record<string, unknown> = {}
  ) =>
    server.log('INFO', 'wrkq.kicker.drive_phase', {
      driveAttemptId,
      targetSessionRef,
      wakeReason,
      phase: name,
      outcome,
      elapsedMs: Date.now() - startedAt,
      ...detail,
    })
  phase('wake_receipt', 'started')
  const summary = {
    considered: 0,
    skipped: 0,
    attempted: 0,
    admitted: 0,
    presented: 0,
    held: 0,
    refused: 0,
    unavailable: 0,
    terminalized: 0,
  }
  const complete = (outcome: string, extra: Record<string, unknown> = {}) =>
    server.log('INFO', 'wrkq.kicker.drive_completed', {
      driveAttemptId,
      targetSessionRef,
      wakeReason,
      outcome,
      elapsedMs: Date.now() - startedAt,
      ...summary,
      stillPending: Math.max(
        0,
        summary.considered - summary.presented - summary.held - summary.terminalized
      ),
      ...extra,
    })
  const completeBirth = (outcome: DriveMailTargetOutcome) => {
    if (outcome?.outcome === 'undeliverable') {
      // Failed and noticed; nothing is left for a later wake to recover.
      summary.terminalized = outcome.failed
      complete('undeliverable', { recovery: 'sender_notice' })
      return
    }
    if (outcome?.outcome === 'birth-refused' && outcome.notPlaceableHere === true) {
      complete('not_placeable_here', { recovery: 'periodic_wake' })
      return
    }
    complete(outcome?.outcome ?? 'birth_deferred', { recovery: 'periodic_wake' })
  }
  // Placement first, before the ledger read or any door. A scope homed on
  // another node cannot be driven from here by any wake reason, so submitting
  // for it only manufactures the failure (T-07650). A ref this daemon cannot
  // parse gets no verdict and falls through to the path that already reported
  // that for what it is.
  const scopeRef = kickerScopeRefFor(targetSessionRef)
  let foreign: Awaited<ReturnType<typeof server.port.resolveForeignHome>>
  try {
    foreign = scopeRef === undefined ? undefined : await server.port.resolveForeignHome(scopeRef)
    phase('home_resolution', 'ok', { ...(scopeRef === undefined ? {} : { scopeRef }) })
  } catch (error) {
    phase('home_resolution', 'failed', {
      diagnostic: boundedFailure('target_resolution', error),
    })
    complete('deferred', { recovery: 'periodic_wake' })
    return
  }
  if (scopeRef !== undefined && foreign !== undefined) {
    skipForeignHomedTarget(server, targetSessionRef, scopeRef, foreign, wakeReason)
    phase('home_resolution', 'skipped', { homeNodeId: foreign.homeNodeId, reason: 'foreign_home' })
    complete('skipped')
    return
  }

  let session: Awaited<ReturnType<typeof server.port.targetBySessionRef>> | undefined
  try {
    session = (await server.port.targetBySessionRef(targetSessionRef)) ?? undefined
    phase('target_session_lookup', 'ok', {
      ...(session === undefined
        ? { sessionFound: false }
        : {
            sessionFound: true,
            hostSessionId: session.hostSessionId,
            generation: session.generation,
          }),
    })
  } catch (error) {
    phase('target_session_lookup', 'failed', {
      diagnostic: boundedFailure('session_lookup', error),
    })
    complete('deferred', { recovery: 'periodic_wake' })
    return
  }
  // §5 — the sender-side failure notices this scope is owed. Delivered here
  // rather than folded into the drive because a notice is not an obligation:
  // it rides a live generation if there is one and waits for the next attend
  // otherwise, and it NEVER summons.
  if (session !== undefined) await deliverFailureNotices(server, targetSessionRef, session)

  let actionable: ActionableEnvelope[]
  try {
    actionable = await readActionableEnvelopes(server, targetSessionRef)
  } catch (error) {
    // wrkq owns the obligations. Unreachable means HRC does not know what to
    // deliver, which is a reason to do nothing, never a reason to guess.
    server.log(
      error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
      'wrkq.kicker.pending_view_failed',
      { targetSessionRef, wakeReason, error: errorText(error) }
    )
    phase('pending_view', 'failed', { diagnostic: boundedFailure('ledger_read', error) })
    complete('deferred', { recovery: 'periodic_wake' })
    return
  }
  summary.considered = actionable.length
  phase('pending_view', 'ok', {
    envelopeIds: boundedEnvelopeIds(actionable.map((item) => item.envelope.id)),
  })
  if (actionable.length === 0) {
    complete('empty')
    return
  }

  if (session === undefined) {
    phase('runtime_selection', 'skipped', { reason: 'no_target_session' })
    const outcome = await birthForTarget(server, targetSessionRef, scopeRef, actionable, wakeReason)
    completeBirth(outcome)
    return outcome
  }

  let seat: Awaited<ReturnType<typeof observeBrokerSeat>>
  try {
    seat = await observeBrokerSeat(server, session)
  } catch (error) {
    phase('seat_probe', 'failed', { diagnostic: boundedFailure('broker_probe', error) })
    for (const item of actionable)
      recordDeferredDiagnostic(server, item.envelope.id, {
        driveAttemptId,
        targetSessionRef,
        wakeReason,
        outcome: 'broker_probe_failed',
        observedSeatState: 'unavailable',
        runtimeId: null,
        invocationId: null,
        diagnostic: null,
      })
    summary.unavailable = actionable.length
    complete('deferred', { recovery: 'periodic_wake' })
    return
  }
  phase('runtime_selection', 'ok', {
    runtimeId: 'runtimeId' in seat ? seat.runtimeId : undefined,
    observedSeatState: seat.state,
  })
  phase('seat_probe', seat.state === 'unavailable' ? 'failed' : 'ok', {
    runtimeId: 'runtimeId' in seat ? seat.runtimeId : undefined,
    observedSeatState: seat.state,
    ...(seat.state === 'unavailable' ? { probeDiagnostic: seat.probeDiagnostic } : {}),
  })

  // An absent seat means there is no harness to submit into, so a
  // SUMMONING envelope takes the launch-carried door — the same one a target
  // with no session row takes. A session row is not a seat: it outlives every
  // runtime, so routing on the row is what sent this case to `enqueue`, where
  // the body was written into a harness still booting and lost the first turn
  // to the launch's own priming prompt (T-08394).
  //
  // A wake set holding ONLY non-summoning mail keeps the pre-existing path: it
  // falls through to `deliverToSeat`, which provisions a runtime for the session
  // row that already exists. That is the contract (T-09643 ruling): a
  // seat-absent fyi MAY birth a runtime for an existing session once its target
  // is driven; it is never itself the wake, and it never mints a session. Routing it here instead silently stopped
  // delivering fyi mail to driven targets with an existing session and an
  // absent broker (regression in 70e683c7, caught by the T-07615 suite).
  if (seat.state === 'absent' && actionable.some((item) => summonsATurn(item.envelope))) {
    const outcome = await birthForTarget(server, targetSessionRef, scopeRef, actionable, wakeReason)
    completeBirth(outcome)
    return outcome
  }
  if (
    seat.state === 'unavailable' ||
    seat.state === 'starting' ||
    seat.state === 'stopping' ||
    seat.state === 'turn-observed'
  ) {
    summary.unavailable = actionable.length
    complete('deferred', { recovery: 'periodic_wake' })
    server.log('INFO', 'wrkq.kicker.seat_not_ready', {
      driveAttemptId,
      targetSessionRef,
      wakeReason,
      observedSeatState: seat.state,
      envelopeIds: boundedEnvelopeIds(actionable.map((item) => item.envelope.id)),
      ...(seat.state === 'unavailable'
        ? {
            runtimeId: seat.runtimeId,
            invocationId: seat.invocationId,
            probeDiagnostic: seat.probeDiagnostic,
          }
        : {}),
    })
    for (const item of actionable)
      recordDeferredDiagnostic(server, item.envelope.id, {
        driveAttemptId,
        targetSessionRef,
        wakeReason,
        outcome: `seat_${seat.state}`,
        observedSeatState: seat.state,
        runtimeId: 'runtimeId' in seat ? seat.runtimeId : null,
        invocationId: seat.state === 'unavailable' ? seat.invocationId : null,
        diagnostic: seat.state === 'unavailable' ? seat.probeDiagnostic : null,
      })
    return
  }

  // A seat this node knows about but the broker calls terminal is a dead
  // generation; nothing can land in it and the runtime-lapse path owns what it
  // was holding.
  if (seat.state === 'terminal') {
    server.log('INFO', 'wrkq.kicker.seat_not_ready', {
      driveAttemptId,
      targetSessionRef,
      wakeReason,
      observedSeatState: seat.state,
      envelopeIds: boundedEnvelopeIds(actionable.map((item) => item.envelope.id)),
    })
    summary.skipped = actionable.length
    complete('terminal_runtime', { recovery: 'runtime_lapse_reconciliation' })
    return
  }

  // T-10159: a fyi that waited for this reader is backlog, and every backlog
  // fyi in this pass goes as ONE digest input after the per-envelope mail, so
  // stale news neither costs a turn per envelope nor gets ahead of an
  // obligation.
  const classified = classifyBacklogFyi(actionable, {
    runtimeBornAt: await runtimeBornAt(server, seat),
  })
  const digest = classified.filter((item) => item.form === 'digest')
  const perEnvelope = classified.filter((item) => item.form !== 'digest')

  for (const item of perEnvelope) {
    summary.attempted++
    const outcome = await deliverToSeat(
      server,
      targetSessionRef,
      session,
      seat,
      item,
      wakeReason,
      driveAttemptId
    ).catch((error: unknown) => {
      server.log('WARN', 'wrkq.kicker.delivery_failed', {
        targetSessionRef,
        wakeReason,
        envelope: item.envelope.id,
        error: errorText(error),
      })
      return 'refused' as const
    })
    // A refusal is about THIS envelope's door, not about the seat, so the pass
    // continues: one envelope whose preview failed must not hold the rest.
    if (outcome === 'refused') {
      summary.refused++
      continue
    }
    if (outcome === 'skipped') {
      summary.skipped++
      continue
    }
    summary.admitted++
    recordRecoveryDiagnostic(server, item.envelope.id, {
      driveAttemptId,
      targetSessionRef,
      wakeReason,
      outcome: 'admitted',
      observedSeatState: seat.state,
      runtimeId: 'runtimeId' in seat ? seat.runtimeId : null,
      invocationId: null,
      diagnostic: null,
    })
  }
  if (digest.length > 0) {
    summary.attempted += digest.length
    const { outcome, members } = await deliverDigestToSeat(
      server,
      targetSessionRef,
      session,
      seat,
      digest,
      wakeReason,
      driveAttemptId
    ).catch((error: unknown) => {
      server.log('WARN', 'wrkq.kicker.delivery_failed', {
        targetSessionRef,
        wakeReason,
        envelopes: digest.map((item) => item.envelope.id),
        form: 'digest',
        error: errorText(error),
      })
      return { outcome: 'refused' as const, members: digest.length }
    })
    if (outcome === 'submitted') summary.admitted += members
    else if (outcome === 'refused') summary.refused += digest.length
    else summary.skipped += digest.length
  }
  complete('completed')
}

/**
 * When the runtime this pass delivers into was born, if it can be known.
 *
 * Unknown — an absent seat, a failed read — is not an error: the backlog rule
 * falls back to envelope age alone, and never to "everything is backlog".
 */
async function runtimeBornAt(
  server: MailKickerContext,
  seat: ObservedBrokerSeat
): Promise<string | undefined> {
  if (!('runtimeId' in seat)) return undefined
  try {
    return (await server.port.runtime(seat.runtimeId))?.createdAt
  } catch (error) {
    server.log('INFO', 'wrkq.kicker.runtime_birth_unknown', {
      runtimeId: seat.runtimeId,
      error: errorText(error),
    })
    return undefined
  }
}

const MAX_ENVELOPE_IDS = 32
function boundedEnvelopeIds(ids: readonly string[]): readonly string[] {
  return ids.length <= MAX_ENVELOPE_IDS
    ? ids
    : [...ids.slice(0, MAX_ENVELOPE_IDS), `…[${ids.length - MAX_ENVELOPE_IDS} more]`]
}

function boundedFailure(boundary: string, error: unknown): Record<string, string> {
  const value = errorText(error)
  return { boundary, message: value.length <= 240 ? value : `${value.slice(0, 227)}…[truncated]` }
}

type DiagnosticRecord = Omit<
  NonNullable<MailKickerContext['store']['driveDiagnostics']> extends infer T
    ? T extends { record(input: infer I): unknown }
      ? I
      : never
    : never,
  'priorDriveAttemptId' | 'recoveredAt'
>

function recordDeferredDiagnostic(
  server: MailKickerContext,
  envelopeId: string,
  input: Omit<DiagnosticRecord, 'envelopeId'>
): void {
  const prior = server.store.driveDiagnostics?.latest(envelopeId)
  server.store.driveDiagnostics?.record({
    envelopeId,
    ...input,
    priorDriveAttemptId: prior?.driveAttemptId ?? null,
    recoveredAt: null,
  })
}

function recordRecoveryDiagnostic(
  server: MailKickerContext,
  envelopeId: string,
  input: Omit<DiagnosticRecord, 'envelopeId'>
): void {
  const prior = server.store.driveDiagnostics?.latest(envelopeId)
  const recoveredAt = prior?.observedSeatState === 'unavailable' ? new Date().toISOString() : null
  server.store.driveDiagnostics?.record({
    envelopeId,
    ...input,
    priorDriveAttemptId: prior?.driveAttemptId ?? null,
    recoveredAt,
  })
  if (recoveredAt !== null) {
    server.log('INFO', 'wrkq.kicker.drive_recovered', {
      driveAttemptId: input.driveAttemptId,
      priorDriveAttemptId: prior?.driveAttemptId,
      targetSessionRef: input.targetSessionRef,
      envelopeId,
      timeToRecoveryMs: Date.parse(recoveredAt) - Date.parse(prior?.createdAt ?? recoveredAt),
    })
  }
}
