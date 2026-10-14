import { parseScopeRef } from 'agent-scope'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeIntent } from 'hrc-core'

import type { AcpHrcClient } from '../deps.js'
import { json } from '../http.js'
import type { RouteContext } from '../routing/route-context.js'
import { expireInputComposedForDroppedContext, restartRefusal } from './mobile-sessions-restart.js'
import { formatSessionIdentityHandle } from './shared.js'

/**
 * T-10942 — "Force new session" on the mobile create route
 * (hrc-ios IOS_FORCE_NEW_PRIMARY_PROPOSAL.md).
 *
 * The operator asks for a fresh `agent@project:primary`, ending whatever
 * conversation lives there. ACP resolves the exact scope through HRC, then
 * either force-restarts the existing context through HRC's semantic restart
 * (with the T-10850 queue cleanup) or exact-claims an absent scope. It never
 * walks the suffix roster and never composes terminate + start itself.
 *
 * A committed restart is a 200 carrying the successor and its launch
 * disposition; a failed launch is recovered with `launch_successor`, which
 * starts that successor and never rotates it. A resubmitted requestId replays
 * or settles through the request ledger and never restarts twice. An HRC
 * answer that never arrived is not inferred from a snapshot of the head: the
 * operator is shown the live head and decides.
 */

export type MobileForceRequest =
  | { mode: 'new_context' }
  | { mode: 'reconcile' }
  | { mode: 'launch_successor'; expectedHostSessionId: string; expectedGeneration: number }

const FORCE_TASK_ID = 'primary'
const LEDGER_LIMIT = 256
const LEDGER_TTL_MS = 30 * 60 * 1000
const MOBILE_RESTART_STYLE = 'reuse_pty'

/** HRC's typed pre-claim refusals for an exact START; nothing was claimed. */
const EXACT_CLAIM_REFUSALS = new Set<string>([
  HrcErrorCode.SESSION_SCOPE_OCCUPIED,
  HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
  HrcErrorCode.ROSTER_CLAIM_SUPERSEDED,
])

type Launch =
  | { status: 'started'; runtimeId: string }
  | { status: 'failed'; code?: string | undefined; message: string }

type Outcome = { status: number; body: Record<string, unknown> }

/** HRC was called and never gave a typed answer. */
type Uncertain = { branch: 'restart' } | { branch: 'create' }

type LedgerState =
  | { kind: 'in_flight'; promise: Promise<Outcome> }
  | { kind: 'done'; outcome: Outcome }
  | { kind: 'uncertain'; uncertain: Uncertain }

type LedgerEntry = {
  agentId: string
  projectId: string
  expiresAt: number
  state: LedgerState
}

const ledgers = new WeakMap<object, Map<string, LedgerEntry>>()

function ledgerFor(deps: object): Map<string, LedgerEntry> {
  let ledger = ledgers.get(deps)
  if (ledger === undefined) {
    ledger = new Map()
    ledgers.set(deps, ledger)
  }
  const now = Date.now()
  for (const [key, entry] of ledger) {
    if (entry.expiresAt <= now && entry.state.kind !== 'in_flight') ledger.delete(key)
  }
  while (ledger.size >= LEDGER_LIMIT) {
    const oldest = ledger.keys().next().value
    if (oldest === undefined) break
    ledger.delete(oldest)
  }
  return ledger
}

function malformed(message: string, field: string): never {
  throw new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, message, { field })
}

export function parseMobileForce(
  body: Record<string, unknown>,
  taskId: string
): MobileForceRequest | undefined {
  const raw = body['force']
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    malformed('force must be an object', 'force')
  }
  if (taskId !== FORCE_TASK_ID) malformed('force is only supported for the primary scope', 'force')
  const force = raw as Record<string, unknown>
  const mode = force['mode']
  if (mode !== 'new_context' && mode !== 'reconcile' && mode !== 'launch_successor') {
    malformed('force.mode must be new_context, reconcile or launch_successor', 'force.mode')
  }
  const allowed =
    mode === 'launch_successor' ? ['mode', 'expectedHostSessionId', 'expectedGeneration'] : ['mode']
  for (const key of Object.keys(force)) {
    if (!allowed.includes(key)) malformed(`unexpected field force.${key}`, `force.${key}`)
  }
  if (mode !== 'launch_successor') return { mode }
  const expectedHostSessionId = force['expectedHostSessionId']
  const expectedGeneration = force['expectedGeneration']
  if (typeof expectedHostSessionId !== 'string' || expectedHostSessionId.trim() === '') {
    malformed('force.expectedHostSessionId is required', 'force.expectedHostSessionId')
  }
  if (typeof expectedGeneration !== 'number' || !Number.isInteger(expectedGeneration)) {
    malformed('force.expectedGeneration is required', 'force.expectedGeneration')
  }
  return {
    mode,
    expectedHostSessionId: (expectedHostSessionId as string).trim(),
    expectedGeneration: expectedGeneration as number,
  }
}

export type ForcePrimaryInput = {
  deps: RouteContext['deps']
  force: MobileForceRequest
  agentId: string
  projectId: string
  requestId: string
  receivedAt: string
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
  idempotencyKey: string
}

function refusal(
  requestId: string,
  status: number,
  code: string,
  message: string,
  detail?: object
): Outcome {
  return {
    status,
    body: { ok: false, requestId, code, message, ...(detail !== undefined ? { detail } : {}) },
  }
}

/** A typed HRC answer is a decision; anything else (transport, untyped 5xx) is not. */
function isTypedHrcDecision(error: unknown): error is HrcDomainError {
  return error instanceof HrcDomainError && error.code !== HrcErrorCode.INTERNAL_ERROR
}

class UncertainError extends Error {
  constructor(
    readonly uncertain: Uncertain,
    readonly upstream: unknown
  ) {
    super(upstream instanceof Error ? upstream.message : String(upstream))
  }
}

type Head = { hostSessionId: string; generation: number; sessionRef: string; scopeRef: string }

type ResolvedHead =
  | { kind: 'absent' }
  | { kind: 'remote'; homeNodeId: string }
  | ({ kind: 'local' } & Head)

async function resolveHead(hrc: AcpHrcClient, sessionRef: string): Promise<ResolvedHead> {
  const resolved = await hrc.resolveSession({ sessionRef })
  if (!resolved.found) return { kind: 'absent' }
  if (resolved.homeNodeId !== undefined) return { kind: 'remote', homeNodeId: resolved.homeNodeId }
  return {
    kind: 'local',
    hostSessionId: resolved.hostSessionId,
    generation: resolved.generation,
    scopeRef: resolved.session.scopeRef,
    sessionRef: `${resolved.session.scopeRef}/lane:${resolved.session.laneRef}`,
  }
}

function activeDetail(head: ResolvedHead): { active: Record<string, unknown> | null } {
  return {
    active:
      head.kind === 'local'
        ? {
            hostSessionId: head.hostSessionId,
            generation: head.generation,
            sessionRef: head.sessionRef,
          }
        : null,
  }
}

function committed(
  disposition: 'restarted' | 'created' | 'launched',
  head: Omit<Head, 'generation'> & { generation: number | undefined },
  launch: Launch,
  extra: { priorHostSessionId?: string; replayed?: boolean } = {}
): Outcome {
  return {
    status: 200,
    body: {
      disposition,
      claimedScope: formatSessionIdentityHandle(head.scopeRef, parseScopeRef(head.scopeRef)),
      sessionRef: head.sessionRef,
      hostSessionId: head.hostSessionId,
      ...(head.generation !== undefined ? { generation: head.generation } : {}),
      ...(extra.priorHostSessionId !== undefined
        ? { priorHostSessionId: extra.priorHostSessionId }
        : {}),
      launch,
      ...(launch.status === 'started' ? { runtimeId: launch.runtimeId, status: 'started' } : {}),
      replayed: extra.replayed ?? false,
    },
  }
}

async function runNewContext(input: ForcePrimaryInput, hrc: AcpHrcClient): Promise<Outcome> {
  const head = await resolveHead(hrc, input.sessionRef)
  if (head.kind === 'remote') {
    return refusal(
      input.requestId,
      422,
      'remote_scope_unsupported',
      `this primary lives on ${head.homeNodeId}; force it from that node`,
      { homeNodeId: head.homeNodeId }
    )
  }
  if (head.kind === 'absent') return await exactStart(input, hrc)

  if (hrc.restartSession === undefined) {
    return refusal(
      input.requestId,
      501,
      'restart_unsupported',
      'this ACP build predates HRC session restart'
    )
  }
  let restarted: Awaited<ReturnType<NonNullable<AcpHrcClient['restartSession']>>>
  try {
    restarted = await hrc.restartSession({
      hostSessionId: head.hostSessionId,
      expectedGeneration: head.generation,
      force: true,
    })
  } catch (error) {
    if (!isTypedHrcDecision(error)) throw new UncertainError({ branch: 'restart' }, error)
    const refused = restartRefusal(error)
    return { status: refused.status, body: { ...refused.body, requestId: input.requestId } }
  }
  expireInputComposedForDroppedContext(input.deps, {
    scopeRef: head.scopeRef,
    laneRef: 'main',
    priorHostSessionId: restarted.priorHostSessionId,
    receivedAt: input.receivedAt,
  })
  return committed(
    'restarted',
    { ...head, hostSessionId: restarted.hostSessionId, generation: restarted.generation },
    restarted.launch,
    { priorHostSessionId: restarted.priorHostSessionId }
  )
}

/**
 * Exact claim-and-start of the absent primary. HRC attributes the claim by
 * this request's idempotency key, so re-issuing it after an uncertain answer
 * replays this request's own claim (and starts that session) or claims anew;
 * it never adopts another caller's session.
 */
async function exactStart(input: ForcePrimaryInput, hrc: AcpHrcClient): Promise<Outcome> {
  let started: Awaited<ReturnType<AcpHrcClient['startRuntime']>>
  try {
    started = await hrc.startRuntime({
      sessionRef: input.sessionRef,
      runtimeIntent: input.runtimeIntent,
      conflictPolicy: 'reject',
      summonIntent: 'implicit',
      idempotencyKey: input.idempotencyKey,
      restartStyle: MOBILE_RESTART_STYLE,
    })
  } catch (error) {
    if (error instanceof HrcDomainError && EXACT_CLAIM_REFUSALS.has(error.code)) {
      return refusal(input.requestId, 409, error.code, error.message, error.detail)
    }
    // Anything else may follow a durable claim whose launch failed.
    throw new UncertainError({ branch: 'create' }, error)
  }
  if (started.claim === undefined) {
    throw new UncertainError({ branch: 'create' }, new Error('HRC exact start returned no claim'))
  }
  // The claim response carries no generation; HRC's head names it.
  const claimed = await resolveHead(hrc, input.sessionRef)
  return committed(
    'created',
    {
      hostSessionId: started.hostSessionId,
      generation:
        claimed.kind === 'local' && claimed.hostSessionId === started.hostSessionId
          ? claimed.generation
          : undefined,
      scopeRef: started.claim.scopeRef,
      sessionRef: started.claim.sessionRef,
    },
    { status: 'started', runtimeId: started.runtimeId },
    { replayed: started.claim.replayed }
  )
}

async function runLaunchSuccessor(
  input: ForcePrimaryInput,
  force: Extract<MobileForceRequest, { mode: 'launch_successor' }>,
  hrc: AcpHrcClient
): Promise<Outcome> {
  const head = await resolveHead(hrc, input.sessionRef)
  if (
    head.kind !== 'local' ||
    head.hostSessionId !== force.expectedHostSessionId ||
    head.generation !== force.expectedGeneration
  ) {
    return refusal(
      input.requestId,
      409,
      'stale_context',
      'the session moved on; nothing was launched',
      activeDetail(head)
    )
  }
  let started: Awaited<ReturnType<AcpHrcClient['startRuntime']>>
  try {
    started = await hrc.startRuntime({
      hostSessionId: head.hostSessionId,
      intent: input.runtimeIntent,
      restartStyle: MOBILE_RESTART_STYLE,
      allowStaleGeneration: true,
    })
  } catch (error) {
    if (!isTypedHrcDecision(error)) throw error
    return committed('launched', head, {
      status: 'failed',
      code: error.code,
      message: error.message,
    })
  }
  // HRC's ensure START carries no head fence; a second restart committing
  // between the check above and this start is the concurrent-rotation risk
  // the T-10850 ADR accepts on Lance's authority (T-10942 r4).
  return committed('launched', head, { status: 'started', runtimeId: started.runtimeId })
}

async function readOnlyUnknown(
  input: ForcePrimaryInput,
  hrc: AcpHrcClient,
  message: string
): Promise<Outcome> {
  const head = await resolveHead(hrc, input.sessionRef)
  return refusal(input.requestId, 409, 'force_outcome_unknown', message, activeDetail(head))
}

/**
 * Settle an upstream-uncertain entry. A snapshot of HRC's head is current
 * authority, not evidence of this request's outcome, so a restart is never
 * declared applied or not applied from it. An exact claim is settled by HRC's
 * own idempotency.
 */
async function settleUncertain(
  input: ForcePrimaryInput,
  hrc: AcpHrcClient,
  uncertain: Uncertain
): Promise<Outcome> {
  if (uncertain.branch === 'create') return await exactStart(input, hrc)
  return await readOnlyUnknown(
    input,
    hrc,
    'HRC did not confirm whether the restart happened; check the live primary before forcing again'
  )
}

function replay(outcome: Outcome): Outcome {
  return outcome.status === 200
    ? { status: 200, body: { ...outcome.body, replayed: true } }
    : outcome
}

async function track(
  ledger: Map<string, LedgerEntry>,
  input: ForcePrimaryInput,
  previous: LedgerEntry | undefined,
  run: () => Promise<Outcome>
): Promise<Outcome> {
  const entry: LedgerEntry = {
    agentId: input.agentId,
    projectId: input.projectId,
    expiresAt: Date.now() + LEDGER_TTL_MS,
    state: { kind: 'done', outcome: { status: 0, body: {} } },
  }
  const promise = run().then(
    (outcome) => {
      entry.state = { kind: 'done', outcome }
      return outcome
    },
    (error: unknown) => {
      if (error instanceof UncertainError) {
        entry.state = { kind: 'uncertain', uncertain: error.uncertain }
        return refusal(
          input.requestId,
          502,
          'force_outcome_unknown',
          `HRC did not confirm the result: ${error.message}`
        )
      }
      // A read failure while settling keeps the earlier uncertainty; a failure
      // before any HRC mutation leaves nothing to remember.
      if (previous?.state.kind === 'uncertain') entry.state = previous.state
      else ledger.delete(input.requestId)
      throw error
    }
  )
  entry.state = { kind: 'in_flight', promise }
  ledger.set(input.requestId, entry)
  return await promise
}

async function forcePrimary(input: ForcePrimaryInput, hrc: AcpHrcClient): Promise<Outcome> {
  if (input.force.mode === 'launch_successor') {
    return await runLaunchSuccessor(input, input.force, hrc)
  }

  const ledger = ledgerFor(input.deps)
  const entry = ledger.get(input.requestId)
  if (
    entry !== undefined &&
    (entry.agentId !== input.agentId || entry.projectId !== input.projectId)
  ) {
    return refusal(
      input.requestId,
      409,
      'idempotency_key_conflict',
      'requestId was reused for a different session request'
    )
  }
  if (entry === undefined) {
    if (input.force.mode === 'reconcile') {
      return await readOnlyUnknown(
        input,
        hrc,
        'this request is no longer known here; check the live primary before forcing again'
      )
    }
    return await track(ledger, input, undefined, () => runNewContext(input, hrc))
  }
  switch (entry.state.kind) {
    case 'in_flight':
      return replay(await entry.state.promise)
    case 'done':
      return replay(entry.state.outcome)
    case 'uncertain': {
      const uncertain = entry.state.uncertain
      return await track(ledger, input, entry, () => settleUncertain(input, hrc, uncertain))
    }
  }
}

export async function handleForcePrimary(input: ForcePrimaryInput): Promise<Response> {
  const outcome = await forcePrimary(input, input.deps.hrcClient as AcpHrcClient)
  return json(outcome.body, outcome.status)
}
