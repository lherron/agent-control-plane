/**
 * One envelope, one submission, write-ahead (spec T-08092 rev 4, D2).
 *
 * Every door — steer, enqueue, preempt, invoke, launch — returns ADMISSION and
 * nothing else; the body is applied asynchronously and the landing is reported
 * later on the committed broker stream. Delivery is therefore ordered so that
 * no landing can precede HRC's own record of having tried:
 *
 *   1. commit the INTENT (envelope, target, door, form, presentation id, seq);
 *   2. call the door, carrying `origin.envelopeId` so the envelope-to-submission
 *      join is reconstructable from the broker's own admission record;
 *   3. fill in what the admission response reported.
 *
 * A crash anywhere in there leaves durable intent rather than nothing, and an
 * envelope with an open intent is never actionable — so the worst case is one
 * reconcile, never a second delivery. Nothing here writes a wrkq receipt: that
 * is `landing.ts`, and only a landing fact earns one.
 */
import { randomUUID } from 'node:crypto'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcSessionRecord, PreemptSubmissionRequest } from 'hrc-core'
import type {
  HrcMailDeliveryDoor,
  HrcMailDeliveryForm,
  HrcMailDeliveryIntent,
  HrcMailDriveWakeReason,
} from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { KickerDispatchOptions, KickerDispatchResult } from '../contracts.js'
import { KICKER_SUBMISSION_TTL_MS, errorText, parseSessionRef } from '../internal.js'
import { formatBacklogDigest, formatEnvelopePresentations } from '../ledger/presentation.js'
import type { EnvelopePresentationForm, PresentableEnvelope } from '../ledger/presentation.js'
import type { WrkqEnvelope } from '../ledger/types.js'
import { presentationRuntimeIdFor } from './authority.js'
import { digestPresentationId } from './digest-group.js'
import { landLaunchIfStarted, recordSteerFallback, steerRefusalFallback } from './landing.js'
import type { ActionableEnvelope } from './presentation.js'
import { actionableDirectives, senderGenerationFor } from './presentation.js'
import type { ObservedBrokerSeat } from './seat.js'

export type DeliveryOutcome = 'submitted' | 'refused' | 'skipped'

/**
 * A compile rejection (ASP `compile-not-ok`) or an HRC admission refusal of a
 * successful compile (`admission-rejected`, T-08713) happens before HRC
 * persists or starts a runtime operation.
 */
const PRE_LAUNCH_ASPD_CODES = new Set(['compile-not-ok', 'admission-rejected'])

function isDefinitePreLaunchRejection(error: unknown): error is HrcDomainError {
  return (
    error instanceof HrcDomainError &&
    error.code === 'runtime_unavailable' &&
    error.detail['route'] === 'aspd' &&
    PRE_LAUNCH_ASPD_CODES.has(String(error.detail['code']))
  )
}

/**
 * Positive proof that HRC refused before admitting a body (T-10183).
 * Presentation conflicts are checked before broker submission on every door;
 * the aspd compile/admission gates likewise precede runtime operations. Other
 * domain errors may follow a write, so neither their type nor their text is
 * enough to release the no-second-body fence.
 */
function isDefiniteDispatchRejection(error: unknown): error is HrcDomainError {
  return (
    error instanceof HrcDomainError &&
    (error.code === HrcErrorCode.PRESENTATION_CONFLICT || isDefinitePreLaunchRejection(error))
  )
}

/**
 * Which door this envelope takes, given what the seat is doing.
 *
 * A stored `hold` is an interruption request and owns its own admission
 * decision; refused authority falls through to the ordinary policy and the
 * eventual receipt says `hold_refused_authority`. Everything else follows the
 * steer ruling (T-08533): steer = send now, enqueue = send after. A steer joins
 * the running turn, or starts one on an idle seat, so it is the door for idle
 * AND turn-active seats whose driver advertises `steer`. Enqueue remains for a
 * driver without `steer`, a runtime that refused steer at the capability layer,
 * and an envelope whose previous steer was refused unwritten (the fallback).
 *
 * The HTTP steer door fails open to enqueue on its own (T-08536), but the
 * kicker calls `dispatchTurn` directly and never passes through that door, so
 * the `steerCapable` pre-check stays: it is what keeps the recorded intent door
 * equal to the door the body actually took.
 */
type SeatDoor = Extract<HrcMailDeliveryDoor, 'steer' | 'enqueue' | 'preempt'>
type InjectionDoor = SeatDoor | 'invoke'

/** Door selection is kicker policy; the port exposes only typed submissions. */
export function submitInjected(
  server: MailKickerContext,
  door: InjectionDoor,
  session: HrcSessionRecord,
  intent: NonNullable<HrcSessionRecord['lastAppliedIntentJson']>,
  prompt: string,
  options: KickerDispatchOptions
): Promise<KickerDispatchResult> {
  return server.port[door](session, intent, prompt, options)
}

function doorFor(
  server: MailKickerContext,
  seat: ObservedBrokerSeat,
  envelopeIds: readonly string[],
  isHold: boolean,
  preemptAuthorized: boolean
): { door: SeatDoor; deliveryOutcome?: string | undefined } {
  if (isHold && preemptAuthorized) return { door: 'preempt' }
  if (
    (seat.state === 'turn-active' || seat.state === 'idle') &&
    seat.steerCapable &&
    !server.mailKickerSteerRefused.has(seat.runtimeId) &&
    !envelopeIds.some((envelopeId) => server.mailKickerSteerFallback.has(envelopeId))
  ) {
    return isHold ? { door: 'steer', deliveryOutcome: 'hold_refused_authority' } : { door: 'steer' }
  }
  return isHold
    ? { door: 'enqueue', deliveryOutcome: 'hold_refused_authority' }
    : { door: 'enqueue' }
}

/** Compose the body wrkq would show for one envelope, writing no receipt. */
async function previewPresentation(
  server: MailKickerContext,
  item: ActionableEnvelope,
  session: HrcSessionRecord,
  runtimeId: string | undefined
): Promise<PresentableEnvelope> {
  const result = await server.ledger.present({
    envelope: item.envelope.id,
    preview: true,
    node: server.nodeId,
    hostSessionId: session.hostSessionId,
    generation: String(session.generation),
    ...(runtimeId === undefined ? {} : { runtimeId }),
  })
  return {
    envelope: result.envelope,
    delivery: result.envelope.delivery,
    // A pointer form carries no body and therefore no history cue: the cue
    // exists to orient a cold reader at first contact, and every pointer goes
    // to a reader who has already had one.
    historyHint: item.form === 'full' && result.historyHint,
    messageCount: result.messageCount,
    ...(result.lastMessageAt === undefined ? {} : { lastMessageAt: result.lastMessageAt }),
    form: item.form,
    ...(item.presentation?.turnEndedAt === undefined
      ? {}
      : { turnEndedAt: item.presentation.turnEndedAt }),
    ...(await senderGenerationFor(server, result.envelope)),
  }
}

function originFor(item: { envelope: WrkqEnvelope }) {
  return {
    principalRef: item.envelope.from.principalRef,
    ...(item.envelope.from.scopeRef === undefined ? {} : { scopeRef: item.envelope.from.scopeRef }),
    envelopeId: item.envelope.id,
  }
}

/**
 * The intent row's form. HRC's column is closed to the per-envelope forms, and a
 * digest member is a FIRST presentation, so it is stored as `full`; what makes
 * it a digest member is its presentation id (see `digest-group.ts`).
 */
function storeFormOf(form: EnvelopePresentationForm): HrcMailDeliveryForm {
  return form === 'digest' ? 'full' : form
}

/**
 * Deliver ONE envelope into a seat that already exists.
 *
 * Returns `skipped` when another wake already holds this envelope's intent —
 * the primary key refusing a second submission is the whole fence — and
 * `refused` when the door itself would not take it, which leaves the envelope
 * exactly as pending as it was for the next pass.
 */
export async function deliverToSeat(
  server: MailKickerContext,
  targetSessionRef: string,
  session: HrcSessionRecord,
  seat: ObservedBrokerSeat,
  item: ActionableEnvelope,
  wakeReason: HrcMailDriveWakeReason,
  driveAttemptId?: string
): Promise<DeliveryOutcome> {
  const runtimeId =
    seat.state === 'absent' ? await presentationRuntimeIdFor(server, session) : seat.runtimeId
  const isHold = item.envelope.delivery === 'hold'

  const intentDoorAndOutcome = doorFor(server, seat, [item.envelope.id], isHold, false)
  let door: SeatDoor = intentDoorAndOutcome.door
  let deliveryOutcome = intentDoorAndOutcome.deliveryOutcome
  // The fallback is spent by the pass that takes it: a later refusal of the
  // enqueue is an enqueue problem, and a later envelope steers as usual.
  if (door === 'enqueue') server.mailKickerSteerFallback.delete(item.envelope.id)

  const runtimeIntent =
    session.lastAppliedIntentJson ??
    (await server.port.resolveRuntimeIntent(
      parseSessionRef(targetSessionRef).scopeRef,
      actionableDirectives([item])
    ))
  if (runtimeIntent === undefined) {
    server.log('WARN', 'wrkq.kicker.delivery_unavailable', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      reason: 'no_runtime_intent_available',
    })
    return 'refused'
  }

  let presentable: PresentableEnvelope
  try {
    presentable = await previewPresentation(server, item, session, runtimeId)
  } catch (error) {
    server.log('WARN', 'wrkq.kicker.presentation_preview_failed', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      error: errorText(error),
    })
    return 'refused'
  }
  const prompt = formatEnvelopePresentations([presentable])

  // A hold's authority is asked BEFORE the intent is written, because the
  // answer decides which door the intent will name.
  if (isHold) {
    const request: PreemptSubmissionRequest = {
      target: targetSessionRef,
      body: prompt,
      origin: originFor(item),
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      turnPolicy: 'guarded',
    }
    const admission = await server.port.preemptAdmission(session, request)
    if (admission === 'authorized') {
      door = 'preempt'
      deliveryOutcome = undefined
    } else if (admission === 'preempt-unsupported') {
      // The receipt vocabulary is closed (§2) and `hold_refused_authority` is
      // its member for "this hold did not interrupt anything" — so the receipt
      // is unchanged and the envelope still lands through the ordinary door.
      // But the receipt cannot say WHY, and this reason is not the sender's
      // fault: the seat's driver does not implement interruption at all, so no
      // grant of authority would ever change the outcome. That fact goes in the
      // log, where an operator asking "why did my hold not interrupt" can find
      // it (T-08337).
      server.log('INFO', 'wrkq.kicker.hold_preempt_unsupported', {
        targetSessionRef,
        wakeReason,
        envelope: item.envelope.id,
        ...(runtimeId === undefined ? {} : { runtimeId }),
        door,
        observedSeatState: seat.state,
      })
    }
  }

  const presentationId = `present-${randomUUID()}`
  const runtime = runtimeId === undefined ? undefined : await server.port.runtime(runtimeId)
  const invocationId = runtime?.activeInvocationId
  const eventsHead = await server.port.eventsHead()
  const seatSnapshot = runtimeId === undefined ? undefined : await server.port.seat(runtimeId)
  const intent = server.store.mailDelivery.openIntent({
    envelopeId: item.envelope.id,
    targetSessionRef,
    door,
    form: storeFormOf(item.form),
    presentationId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(deliveryOutcome === undefined ? {} : { deliveryOutcome }),
    submittedHrcSeq: eventsHead.hrcSeq,
    ...(invocationId === undefined
      ? {}
      : {
          invocationId,
          brokerAfterSeq: seatSnapshot?.currentBrokerSeq ?? 0,
        }),
  })
  if (intent === undefined) return 'skipped'

  server.log('INFO', 'wrkq.kicker.delivery_intent', {
    ...(driveAttemptId === undefined ? {} : { driveAttemptId }),
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door,
    form: item.form,
    presentationId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    observedSeatState: seat.state,
    ...(seat.state === 'turn-active'
      ? { turnId: seat.turnId, steerCapable: seat.steerCapable }
      : {}),
  })

  let body: KickerDispatchResult
  try {
    body = await submitInjected(server, door, session, runtimeIntent, prompt, {
      waitForCompletion: false,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      ...(door === 'preempt' ? { turnPolicy: 'guarded' as const } : {}),
      submissionOrigin: originFor(item),
    })
  } catch (error) {
    // D2: a positively unwritten refusal leaves the envelope pending for the
    // next ordinary drive. Do not self-wake a persistent conflict into a loop.
    // A lost RPC response remains uncertain: the broker may have written.
    if (isDefiniteDispatchRejection(error)) {
      server.store.mailDelivery.clearIntent(item.envelope.id)
    } else {
      server.store.mailDelivery.markUncertain(item.envelope.id, 'dispatch_error', 'dispatch_error')
    }
    server.log('WARN', 'wrkq.kicker.delivery_failed', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      door,
      error: errorText(error),
      deliveryEvidence: isDefiniteDispatchRejection(error) ? 'not_written' : 'uncertain',
    })
    return 'refused'
  }

  const submissionId = body.submissionId ?? body.inputId
  if (body.admission === 'rejected') {
    server.store.mailDelivery.clearIntent(item.envelope.id)
    const reason = body.reason ?? 'no_submission_identity'
    // An admission refusal wrote nothing. A steer refused by a guarded turn,
    // authority or capability is best effort that did not happen, never a lost
    // envelope: queue this one behind that turn on the very next pass (T-08533).
    const fallback =
      door === 'steer' && runtimeId !== undefined
        ? await steerRefusalFallback(server, runtimeId, body.submissionId, reason)
        : undefined
    if (fallback !== undefined && runtimeId !== undefined) {
      recordSteerFallback(server, item.envelope.id, runtimeId, fallback)
    }
    server.log('WARN', 'wrkq.kicker.landing_refused', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      door,
      reason,
      phase: 'admission',
      ...(fallback === undefined ? {} : { fallbackDoor: 'enqueue' }),
    })
    if (fallback !== undefined) server.wake(targetSessionRef, 'insert')
    return 'refused'
  }
  if (submissionId === undefined) {
    server.store.mailDelivery.markUncertain(
      item.envelope.id,
      'missing_submission_identity',
      'admission_response'
    )
    return 'submitted'
  }

  server.store.mailDelivery.attachAdmission(item.envelope.id, {
    submissionId,
    ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
    hostSessionId: body.hostSessionId,
    generation: body.generation,
  })
  server.log('INFO', 'wrkq.kicker.delivery_admitted', {
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door,
    submissionId,
    ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
  })
  return 'submitted'
}

/**
 * Deliver every BACKLOG fyi of one drive as ONE digest submission (T-10159).
 *
 * The body is `formatBacklogDigest`: one line per envelope, no bodies. The fence
 * is unchanged and still per envelope — each member gets its own intent, opened
 * before the door is called, carrying a presentation id that names the group.
 * So a member another wake already holds drops out of this digest rather than
 * being delivered twice, and the rest go on without it.
 *
 * The digest is all-or-nothing at the door: a refused admission clears every
 * member's intent and none is receipted or acked, so the whole set is still
 * pending, still backlog, and is retried as a digest on the next drive; a door
 * that threw, or admitted without a submission id, fences every member as
 * uncertain. A landing (see `landing.ts`) receipts every member under one
 * landing sequence, and wrkq's own `fyi_presented` ack follows each receipt.
 *
 * A digest never preempts: stale news is not an interruption, whatever the
 * sender asked for. A held member keeps the `hold_refused_authority` outcome
 * the ordinary path gives a hold that did not interrupt anything.
 */
export async function deliverDigestToSeat(
  server: MailKickerContext,
  targetSessionRef: string,
  session: HrcSessionRecord,
  seat: ObservedBrokerSeat,
  items: readonly ActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason,
  driveAttemptId?: string
): Promise<{ outcome: DeliveryOutcome; members: number }> {
  const runtimeId =
    seat.state === 'absent' ? await presentationRuntimeIdFor(server, session) : seat.runtimeId
  const { door } = doorFor(
    server,
    seat,
    items.map((item) => item.envelope.id),
    false,
    false
  )
  if (door === 'enqueue') {
    for (const item of items) server.mailKickerSteerFallback.delete(item.envelope.id)
  }

  const runtimeIntent =
    session.lastAppliedIntentJson ??
    (await server.port.resolveRuntimeIntent(
      parseSessionRef(targetSessionRef).scopeRef,
      actionableDirectives(items)
    ))
  if (runtimeIntent === undefined) {
    server.log('WARN', 'wrkq.kicker.delivery_unavailable', {
      targetSessionRef,
      wakeReason,
      envelopes: items.map((item) => item.envelope.id),
      form: 'digest',
      reason: 'no_runtime_intent_available',
    })
    return { outcome: 'refused', members: 0 }
  }

  // Re-read every member: one acked, failed or withdrawn since the pending view
  // drops out here rather than being resurrected by a digest line.
  const current: WrkqEnvelope[] = []
  for (const item of items) {
    try {
      const row = await server.ledger.envelopeShow({ envelope: item.envelope.id })
      if (row.state === 'pending' && !row.terminal) current.push(row)
      else {
        server.log('INFO', 'wrkq.kicker.digest_member_dropped', {
          targetSessionRef,
          envelope: item.envelope.id,
          state: row.state,
        })
      }
    } catch (error) {
      server.log('WARN', 'wrkq.kicker.presentation_preview_failed', {
        targetSessionRef,
        wakeReason,
        envelope: item.envelope.id,
        form: 'digest',
        error: errorText(error),
      })
    }
  }
  current.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  if (current.length === 0) return { outcome: 'skipped', members: 0 }

  const groupId = randomUUID()
  const runtime = runtimeId === undefined ? undefined : await server.port.runtime(runtimeId)
  const invocationId = runtime?.activeInvocationId
  const eventsHead = await server.port.eventsHead()
  const seatSnapshot = runtimeId === undefined ? undefined : await server.port.seat(runtimeId)
  const opened: Array<{ envelope: WrkqEnvelope; intent: HrcMailDeliveryIntent }> = []
  for (const envelope of current) {
    const intent = server.store.mailDelivery.openIntent({
      envelopeId: envelope.id,
      targetSessionRef,
      door,
      form: storeFormOf('digest'),
      presentationId: digestPresentationId(groupId, envelope.id),
      ...(runtimeId === undefined ? {} : { runtimeId }),
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      ...(envelope.delivery === 'hold' ? { deliveryOutcome: 'hold_refused_authority' } : {}),
      submittedHrcSeq: eventsHead.hrcSeq,
      ...(invocationId === undefined
        ? {}
        : { invocationId, brokerAfterSeq: seatSnapshot?.currentBrokerSeq ?? 0 }),
    })
    // Another wake holds this one: it is that wake's to deliver, not ours.
    if (intent !== undefined) opened.push({ envelope, intent })
  }
  const leader = opened[0]?.envelope
  if (leader === undefined) return { outcome: 'skipped', members: 0 }
  const members = opened.map(({ envelope }) => envelope.id)

  for (const { envelope, intent } of opened) {
    server.log('INFO', 'wrkq.kicker.delivery_intent', {
      ...(driveAttemptId === undefined ? {} : { driveAttemptId }),
      targetSessionRef,
      wakeReason,
      envelope: envelope.id,
      door,
      form: 'digest',
      digestGroup: groupId,
      digestMembers: members,
      presentationId: intent.presentationId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
      observedSeatState: seat.state,
    })
  }

  const prompt = formatBacklogDigest(
    opened.map(({ envelope }) => envelope),
    new Date()
  )
  const clearAll = () => {
    for (const id of members) server.store.mailDelivery.clearIntent(id)
  }
  const uncertainAll = (cause: string, kind: string) => {
    for (const id of members) server.store.mailDelivery.markUncertain(id, cause, kind)
  }

  let body: KickerDispatchResult
  try {
    body = await submitInjected(server, door, session, runtimeIntent, prompt, {
      waitForCompletion: false,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      // The broker's admission record names ONE envelope; the oldest member
      // stands for the digest and `digest-group.ts` finds the rest.
      submissionOrigin: originFor({ envelope: leader }),
    })
  } catch (error) {
    if (isDefiniteDispatchRejection(error)) clearAll()
    else uncertainAll('dispatch_error', 'dispatch_error')
    server.log('WARN', 'wrkq.kicker.delivery_failed', {
      targetSessionRef,
      wakeReason,
      envelopes: members,
      form: 'digest',
      door,
      error: errorText(error),
      deliveryEvidence: isDefiniteDispatchRejection(error) ? 'not_written' : 'uncertain',
    })
    return { outcome: 'refused', members: members.length }
  }

  const submissionId = body.submissionId ?? body.inputId
  if (body.admission === 'rejected') {
    clearAll()
    const reason = body.reason ?? 'no_submission_identity'
    const fallback =
      door === 'steer' && runtimeId !== undefined
        ? await steerRefusalFallback(server, runtimeId, body.submissionId, reason)
        : undefined
    if (fallback !== undefined && runtimeId !== undefined) {
      for (const id of members) recordSteerFallback(server, id, runtimeId, fallback)
    }
    server.log('WARN', 'wrkq.kicker.landing_refused', {
      targetSessionRef,
      wakeReason,
      envelopes: members,
      form: 'digest',
      door,
      reason,
      phase: 'admission',
      ...(fallback === undefined ? {} : { fallbackDoor: 'enqueue' }),
    })
    if (fallback !== undefined) server.wake(targetSessionRef, 'insert')
    return { outcome: 'refused', members: members.length }
  }
  if (submissionId === undefined) {
    uncertainAll('missing_submission_identity', 'admission_response')
    return { outcome: 'submitted', members: members.length }
  }

  for (const id of members) {
    server.store.mailDelivery.attachAdmission(id, {
      submissionId,
      ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
      hostSessionId: body.hostSessionId,
      generation: body.generation,
    })
  }
  server.log('INFO', 'wrkq.kicker.delivery_admitted', {
    targetSessionRef,
    wakeReason,
    envelopes: members,
    form: 'digest',
    digestGroup: groupId,
    door,
    submissionId,
    ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
  })
  return { outcome: 'submitted', members: members.length }
}

/**
 * Deliver ONE envelope by BIRTHING the seat (the launch-carried path).
 *
 * This is the one path where the body is not a submission: HRC places it in
 * `spec.launch.initialPrompt` and the born runtime's first turn IS the delivery
 * (`harness-broker-admission-client`). Its landing fact is that runtime's first
 * `turn.started`, which `landing.ts` observes. One launch carries one envelope;
 * further pending mail for the seat is delivered by policy once it is live.
 *
 * The intent is committed before `ensureTargetSession`, so a birth that
 * succeeds and a daemon that dies before recording it are reconciled against
 * the launch this node durably made rather than guessed at.
 */
export async function deliverByColdBirth(
  server: MailKickerContext,
  targetSessionRef: string,
  item: ActionableEnvelope,
  wakeReason: HrcMailDriveWakeReason
): Promise<DeliveryOutcome | 'birth-refused'> {
  const scopeRef = parseSessionRef(targetSessionRef).scopeRef
  const runtimeIntent = await server.port.resolveRuntimeIntent(
    scopeRef,
    actionableDirectives([item])
  )
  if (runtimeIntent === undefined) {
    // Placement is HRC's, so a missing intent means this node could not find
    // the target agent's profile — not that the sender forgot something.
    server.log('WARN', 'wrkq.kicker.placement_unresolvable', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
    })
    return 'refused'
  }

  const presentationId = `present-${randomUUID()}`
  const intent = server.store.mailDelivery.openIntent({
    envelopeId: item.envelope.id,
    targetSessionRef,
    door: 'launch',
    form: storeFormOf(item.form),
    presentationId,
    submittedHrcSeq: (await server.port.eventsHead()).hrcSeq,
  })
  if (intent === undefined) return 'skipped'

  server.log('INFO', 'wrkq.kicker.delivery_intent', {
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door: 'launch',
    form: item.form,
    presentationId,
    observedSeatState: 'absent',
  })

  let session: HrcSessionRecord
  try {
    // The only message-traffic provisioning path. `ensureTargetSession` enters
    // the normal summon/placement gate before it mints anything, so a scope
    // this node does not home is refused here rather than pre-filtered.
    session = await server.port.ensureTargetSession(targetSessionRef, runtimeIntent, {
      persistIntent: false,
    })
    // The seat exists, so this node no longer owes the birth. Left open, the
    // refusal keeps the scope in every later sweep's candidate set for nothing.
    server.store.mailDelivery.resolveBirthRefusal(targetSessionRef, 'birth established')
  } catch (error) {
    server.store.mailDelivery.clearIntent(item.envelope.id)
    throw error
  }

  let presentable: PresentableEnvelope
  try {
    presentable = await previewPresentation(
      server,
      item,
      session,
      await presentationRuntimeIdFor(server, session)
    )
  } catch (error) {
    server.store.mailDelivery.clearIntent(item.envelope.id)
    server.log('WARN', 'wrkq.kicker.presentation_preview_failed', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      error: errorText(error),
    })
    return 'refused'
  }

  let body: KickerDispatchResult
  try {
    body = await submitInjected(
      server,
      'invoke',
      session,
      session.lastAppliedIntentJson ?? runtimeIntent,
      formatEnvelopePresentations([presentable]),
      {
        waitForCompletion: false,
        ttlMs: KICKER_SUBMISSION_TTL_MS,
        submissionOrigin: originFor(item),
        // A summons that finds no broker seat is the first user turn of a
        // launch-primed interactive birth. The interactive route verifies the
        // selected profile before putting it on launch; every other route
        // ignores this hint and keeps promptless boot + broker admission.
        launchPromptOnColdBirth: true,
      }
    )
  } catch (error) {
    if (isDefiniteDispatchRejection(error)) {
      // A cold-birth race can find a live seat and refuse presentation before
      // admission, just as the aspd compile/admission gate can refuse before
      // launch. Both prove not-written; neither needs an uncertainty fence.
      server.store.mailDelivery.clearIntent(item.envelope.id)
      server.log(
        'WARN',
        isDefinitePreLaunchRejection(error)
          ? 'wrkq.kicker.birth_compile_rejected'
          : 'wrkq.kicker.delivery_failed',
        {
          targetSessionRef,
          wakeReason,
          envelope: item.envelope.id,
          error: error.message,
          detail: error.detail,
        }
      )
      throw error
    }
    // The invoke/launch RPC may have reached the provider before its response
    // was lost. It is an uncertain delivery, never a new birth opportunity.
    server.store.mailDelivery.markUncertain(item.envelope.id, 'dispatch_error', 'dispatch_error')
    throw error
  }

  const runtimeId = body.runtimeId ?? (await presentationRuntimeIdFor(server, session))
  const submissionId = body.submissionId ?? body.inputId
  if (submissionId === undefined) {
    // T-07693: a cold birth's delivery class has NO invocation input — the
    // prompt rides the runtime's `initialPrompt`. Its landing fact is the born
    // runtime's first turn start, not a submission disposition.
    server.store.mailDelivery.attachAdmission(item.envelope.id, {
      door: 'launch',
      ...(runtimeId === undefined ? {} : { runtimeId }),
      hostSessionId: body.hostSessionId,
      generation: body.generation,
    })
    server.log('INFO', 'wrkq.kicker.launch_carried', {
      targetSessionRef,
      wakeReason,
      envelope: item.envelope.id,
      ...(runtimeId === undefined ? {} : { runtimeId }),
      hostSessionId: body.hostSessionId,
      generation: body.generation,
    })
    // The born runtime's first turn commonly starts DURING the launch, before
    // this intent knew which runtime the launch produced — so the live observer
    // saw a turn start with no intent to match. Check once here, where the
    // correlation finally exists.
    const current = server.store.mailDelivery.getIntent(item.envelope.id)
    if (current !== undefined) await landLaunchIfStarted(server, current)
    return 'submitted'
  }

  // The birth admitted an ordinary submission instead: this is an invoke, and
  // its landing is a submission disposition like any other door's.
  server.store.mailDelivery.attachAdmission(item.envelope.id, {
    door: 'invoke',
    submissionId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    hostSessionId: body.hostSessionId,
    generation: body.generation,
  })
  server.log('INFO', 'wrkq.kicker.delivery_admitted', {
    targetSessionRef,
    wakeReason,
    envelope: item.envelope.id,
    door: 'invoke',
    submissionId,
    ...(runtimeId === undefined ? {} : { runtimeId }),
  })
  return 'submitted'
}
