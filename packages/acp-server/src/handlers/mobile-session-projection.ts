import {
  type HrcLifecycleEvent,
  type HrcRunRecord,
  type HrcRuntimeSnapshot,
  type HrcSessionRecord,
  isTerminalRuntimeStatus,
} from 'hrc-core'

import { hasHrcEvidenceOrigin } from '../hrc-evidence-origin.js'

export type MobileSessionMode = 'interactive' | 'headless'
type MobileSessionStatus = 'active' | 'stale' | 'inactive' | 'detached'
export type MobileExecutionMode = 'interactive' | 'headless' | 'nonInteractive'
type MobileSessionSourceKind = 'local_session' | 'remote_runtime_projection'
type MobileContextReading = {
  turnId: string
  usedTokens: number
  windowTokens?: number | undefined
  model?: { id: string; source: 'provider-response' | 'harness-config' } | undefined
  observedAt: string
}

function projectContextReading(
  runtime: HrcRuntimeSnapshot | null | undefined
): MobileContextReading | undefined {
  const value = runtime?.runtimeStateJson?.['contextReading']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const reading = value as Record<string, unknown>
  if (
    typeof reading['turnId'] !== 'string' ||
    typeof reading['observedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(reading['observedAt'])) ||
    typeof reading['usedTokens'] !== 'number' ||
    !Number.isSafeInteger(reading['usedTokens']) ||
    reading['usedTokens'] < 0
  )
    return undefined
  const window = reading['windowTokens']
  if (
    window !== undefined &&
    (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0)
  )
    return undefined
  const rawModel = reading['model']
  const model =
    typeof rawModel === 'object' && rawModel !== null && !Array.isArray(rawModel)
      ? (rawModel as Record<string, unknown>)
      : undefined
  const projectedModel =
    model &&
    typeof model['id'] === 'string' &&
    (model['source'] === 'provider-response' || model['source'] === 'harness-config')
      ? ({ id: model['id'], source: model['source'] } as NonNullable<MobileContextReading['model']>)
      : undefined
  return {
    turnId: reading['turnId'],
    usedTokens: reading['usedTokens'],
    ...(window !== undefined ? { windowTokens: window as number } : {}),
    ...(projectedModel !== undefined ? { model: projectedModel } : {}),
    observedAt: reading['observedAt'],
  }
}

export type MobileSessionSummary = {
  context?: MobileContextReading | undefined
  nodeId?: string | undefined
  sourceKind?: MobileSessionSourceKind | undefined
  projectionState?: 'answered' | 'unreachable' | 'refused' | 'invalid_response' | undefined
  projectionCheckedAt?: string | undefined
  projectionAnsweredAt?: string | undefined
  /** T-13191: HRC's seat disposition from its session page item; null when unparked or unserved. */
  disposition?: 'parked' | null | undefined
  dispositionAt?: string | null | undefined
  sessionRef: string
  displayRef: string
  title: string
  mode: MobileSessionMode
  executionMode: MobileExecutionMode
  summaryStatus: MobileSessionStatus
  /** @deprecated Use summaryStatus. Preserved for the older /mobile/sessions client. */
  status?: MobileSessionStatus | undefined
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  activeTurnId?: string | undefined
  lastHrcSeq: number
  lastMessageSeq: number
  lastActivityAt?: string | undefined
  capabilities: {
    input: boolean
    interrupt: boolean
    launchHeadlessTurn: boolean
    history: boolean
    summary?: boolean | undefined
    semanticDm?: boolean | undefined
    timeline?: boolean | undefined
    literalInput?: boolean | undefined
    answerPrompt?: boolean | undefined
  }
  session?: {
    status: string
    generation: number
    priorHostSessionId?: string | undefined
    continuation?: HrcSessionRecord['continuation'] | undefined
    lastAppliedIntent?: HrcSessionRecord['lastAppliedIntentJson'] | undefined
    createdAt: string
    updatedAt: string
  }
  runtime?:
    | {
        status: string
        transport: string
        runtimeId: string
        activeRunId?: string | undefined
        lastActivityAt?: string | undefined
        supportsInflightInput: boolean
        /**
         * Always false: HRC retired runtime adoption (T-10146), but HRC Mobile
         * builds through 0.1.42 decode this as a required Bool and drop the whole
         * session page without it. Remove once no installed build requires it.
         */
        adopted: false
        createdAt: string
        updatedAt: string
      }
    | undefined
  run?:
    | {
        status: string
        runId: string
        transport: string
        runtimeId?: string | undefined
        acceptedAt?: string | undefined
        startedAt?: string | undefined
        completedAt?: string | undefined
        errorCode?: string | undefined
        errorMessage?: string | undefined
        updatedAt: string
      }
    | undefined
  raw?:
    | {
        session: HrcSessionRecord
        runtime?: HrcRuntimeSnapshot | undefined
        run?: HrcRunRecord | undefined
      }
    | undefined
}

export type MobileEventMessage = {
  type: 'hrc_event'
  hrcSeq: number
  streamSeq: number
  eventKind: string
  category: string
  ts: string
  payload: unknown
  scopeRef?: string | undefined
  laneRef?: string | undefined
  sessionRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  replayed?: boolean | undefined
  errorCode?: string | undefined
}

export function sessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneRef}`
}

export function latestRuntimeForSession(
  session: HrcSessionRecord,
  runtimes: HrcRuntimeSnapshot[]
): HrcRuntimeSnapshot | undefined {
  const matches = runtimes.filter(
    (runtime) =>
      runtime.hostSessionId === session.hostSessionId && runtime.generation === session.generation
  )
  return matches.sort((lhs, rhs) => rhs.updatedAt.localeCompare(lhs.updatedAt))[0]
}

function executionMode(
  session: HrcSessionRecord,
  runtime?: HrcRuntimeSnapshot
): MobileExecutionMode {
  const preferred = session.lastAppliedIntentJson?.execution?.preferredMode
  if (preferred === 'headless' || preferred === 'interactive' || preferred === 'nonInteractive') {
    return preferred
  }
  if (runtime?.transport === 'headless') return 'headless'
  return runtime?.supportsInflightInput === true ? 'interactive' : 'nonInteractive'
}

/**
 * `mode` is the binary the app buckets on: only an `interactive` execution mode
 * is an interactive session; `headless` and `nonInteractive` (wrkc/webhook-driven
 * workers) are both headless, and a headless transport is headless regardless.
 */
export function modeForExecution(
  execution: MobileExecutionMode,
  runtime?: HrcRuntimeSnapshot
): MobileSessionMode {
  if (runtime?.transport === 'headless') return 'headless'
  return execution === 'interactive' ? 'interactive' : 'headless'
}

function mobileMode(
  execution: MobileExecutionMode,
  runtime?: HrcRuntimeSnapshot
): MobileSessionMode {
  return modeForExecution(execution, runtime)
}

export function mobileStatus(status: string, runtime?: HrcRuntimeSnapshot): MobileSessionStatus {
  const normalized = status.toLowerCase()
  if (normalized.includes('stale')) return 'stale'
  if (
    normalized.includes('inactive') ||
    normalized.includes('archived') ||
    normalized.includes('closed') ||
    normalized.includes('terminated')
  ) {
    return 'inactive'
  }
  const runtimeStatus = runtime?.status
  if (runtimeStatus === 'detached') return 'detached'
  if (runtimeStatus === 'stale') return 'stale'
  if (
    runtime === undefined ||
    (runtimeStatus !== undefined && isTerminalRuntimeStatus(runtimeStatus))
  ) {
    return 'inactive'
  }
  switch (runtimeStatus) {
    case 'idle':
    case 'ready':
    case 'starting':
    case 'running':
    case 'busy':
    case 'awaiting_input':
      return 'active'
    default:
      return 'inactive'
  }
}

export function projectSession(input: {
  record: HrcSessionRecord
  runtime?: HrcRuntimeSnapshot | undefined
  run?: HrcRunRecord | undefined
  lastEvent?: HrcLifecycleEvent | undefined
  raw?: boolean | undefined
  includeSessionDetails?: boolean | undefined
}): MobileSessionSummary {
  const execution = executionMode(input.record, input.runtime)
  const mode = mobileMode(execution, input.runtime)
  const status = mobileStatus(input.record.status, input.runtime)
  const runtimeActive =
    input.runtime?.status === 'busy' || input.runtime?.status === 'awaiting_input'
  // A terminal runtime's own in-flight-input flag decides literal input,
  // whatever the seat's preferred mode: a seat woken headless by room mail is
  // still a live TUI (Lance 2026-11-24, R-00777).
  const supportsInput =
    (input.runtime?.transport === 'tmux' || input.runtime?.transport === 'hrcpty') &&
    input.runtime.supportsInflightInput === true
  const projectedRuntime =
    input.runtime === undefined
      ? undefined
      : {
          status: input.runtime.status,
          transport: input.runtime.transport,
          runtimeId: input.runtime.runtimeId,
          ...(input.runtime.activeRunId !== undefined
            ? { activeRunId: input.runtime.activeRunId }
            : {}),
          ...(input.runtime.lastActivityAt !== undefined
            ? { lastActivityAt: input.runtime.lastActivityAt }
            : {}),
          supportsInflightInput: input.runtime.supportsInflightInput,
          adopted: false as const,
          createdAt: input.runtime.createdAt,
          updatedAt: input.runtime.updatedAt,
        }
  const projectedRun =
    input.run === undefined
      ? undefined
      : {
          status: input.run.status,
          runId: input.run.runId,
          transport: input.run.transport,
          ...(input.run.runtimeId !== undefined ? { runtimeId: input.run.runtimeId } : {}),
          ...(input.run.acceptedAt !== undefined ? { acceptedAt: input.run.acceptedAt } : {}),
          ...(input.run.startedAt !== undefined ? { startedAt: input.run.startedAt } : {}),
          ...(input.run.completedAt !== undefined ? { completedAt: input.run.completedAt } : {}),
          ...(input.run.errorCode !== undefined ? { errorCode: input.run.errorCode } : {}),
          ...(input.run.errorMessage !== undefined ? { errorMessage: input.run.errorMessage } : {}),
          updatedAt: input.run.updatedAt,
        }

  const includeSessionDetails = input.includeSessionDetails === true || input.raw === true

  return {
    sourceKind: 'local_session',
    context: projectContextReading(input.runtime),
    sessionRef: sessionRef(input.record.scopeRef, input.record.laneRef),
    displayRef: sessionRef(input.record.scopeRef, input.record.laneRef),
    title: input.record.identity?.agentId ?? input.record.scopeRef,
    mode,
    executionMode: execution,
    summaryStatus: status,
    status,
    hostSessionId: input.record.hostSessionId,
    generation: input.record.generation,
    ...(input.runtime?.runtimeId !== undefined ? { runtimeId: input.runtime.runtimeId } : {}),
    ...(input.runtime?.activeRunId !== undefined
      ? { activeTurnId: input.runtime.activeRunId }
      : {}),
    lastHrcSeq: input.lastEvent?.hrcSeq ?? 0,
    lastMessageSeq: 0,
    // A latest event with an evidence origin is history re-projected at a fresh
    // hrc_seq: it advances the cursor but never sets current freshness.
    lastActivityAt:
      (input.lastEvent !== undefined && !hasHrcEvidenceOrigin(input.lastEvent)
        ? input.lastEvent.ts
        : undefined) ??
      input.runtime?.lastActivityAt ??
      input.record.updatedAt,
    capabilities: {
      input: supportsInput,
      interrupt: runtimeActive || input.runtime !== undefined,
      launchHeadlessTurn: false,
      history: true,
      summary: true,
      semanticDm: true,
      timeline: true,
      literalInput: supportsInput,
      answerPrompt: true,
    },
    session: {
      status: input.record.status,
      generation: input.record.generation,
      ...(input.record.priorHostSessionId !== undefined
        ? { priorHostSessionId: input.record.priorHostSessionId }
        : {}),
      ...(includeSessionDetails && input.record.continuation !== undefined
        ? { continuation: input.record.continuation }
        : {}),
      ...(includeSessionDetails && input.record.lastAppliedIntentJson !== undefined
        ? { lastAppliedIntent: input.record.lastAppliedIntentJson }
        : {}),
      createdAt: input.record.createdAt,
      updatedAt: input.record.updatedAt,
    },
    ...(projectedRuntime !== undefined ? { runtime: projectedRuntime } : {}),
    ...(projectedRun !== undefined ? { run: projectedRun } : {}),
    ...(input.raw === true
      ? {
          raw: {
            session: input.record,
            ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
            ...(input.run !== undefined ? { run: input.run } : {}),
          },
        }
      : {}),
  }
}
