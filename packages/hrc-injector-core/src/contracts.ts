import type {
  BrokerEventsQueryOp,
  BrokerEventsQueryResponse,
  EventsHeadResponse,
  HrcBrokerInvocationEventRecord,
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcSubmissionDisposition,
  ListPlacementBindingsResponse,
  ListUnbornDesignationsResponse,
  PreemptAdmission,
  PreemptSubmissionRequest,
  RuntimeSeatResponse,
} from 'hrc-core'
import type { HrcMailDeliveryRepository, WrkqLedgerCursorRepository } from 'hrc-store-sqlite'
import type { SeatProbeResponse, SubmissionWithdrawResponse } from 'spaces-harness-broker-protocol'

export type InjectorLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** A non-local home reported by HRC's public placement surface. */
export type ForeignHome = Readonly<{
  homeNodeId: string
  source: 'placement-ledger' | 'registry'
}>

export type InjectionRpcResult<T> =
  | { ok: true; response: T }
  | { ok: false; error: { message: string } }

export type InjectionDispatchOptions = {
  /** Caller-stable identity for replay after an ambiguous dispatch response. */
  idempotencyKey?: string | undefined
  waitForCompletion?: boolean | undefined
  ttlMs: number
  turnPolicy?: 'guarded' | undefined
  submissionOrigin: {
    principalRef: string
    scopeRef?: string | undefined
    envelopeId?: string | undefined
  }
  launchPromptOnColdBirth?: boolean | undefined
}

export type InjectionDispatchResult = {
  disposition?: HrcSubmissionDisposition | undefined
  inputId?: string | undefined
  delivery?: { code?: string | undefined } | undefined
}

/**
 * The authoritative, per-runtime read needed by delivery policy.  Keep this
 * intentionally narrower than the fleet-list projection: the socket adapter
 * obtains it from HRC's exact `inspectRuntime` route, which does not promise
 * list-only capability or adoption fields.
 */
export type HrcRuntimeLookup = Pick<
  HrcRuntimeSnapshot,
  'runtimeId' | 'status' | 'activeInvocationId'
>

/**
 * The complete public HRC surface that an external delivery owner may use.
 *
 * This structural port deliberately exposes no HRC store, server instance, or
 * dispatch closure. The process that owns delivery can therefore be restarted
 * independently without acquiring an in-process HRC writer.
 */
export type HrcInjectionPort = {
  runtime(runtimeId: string): Promise<HrcRuntimeLookup | undefined>
  runtimesByHostSession(hostSessionId: string): Promise<readonly HrcRuntimeSnapshot[]>
  allRuntimes(): Promise<readonly HrcRuntimeSnapshot[]>
  liveSessionRefs(): Promise<readonly string[]>
  seat(runtimeId: string): Promise<RuntimeSeatResponse>
  withdraw(
    input:
      | { runtimeId: string; submissionId: string; reason: string }
      | { runtimeId: string; envelopeId: string; reason: string }
  ): Promise<InjectionRpcResult<SubmissionWithdrawResponse>>
  resolveForeignHome(scopeRef: string): Promise<ForeignHome | undefined>
  resolveRuntimeIntent(
    scopeRef: string,
    materializationIntent: string | undefined
  ): Promise<HrcRuntimeIntent | undefined>
  targetBySessionRef(targetSessionRef: string): Promise<HrcSessionRecord | undefined>
  ensureTargetSession(
    targetSessionRef: string,
    intent: HrcRuntimeIntent,
    options: { persistIntent: false }
  ): Promise<HrcSessionRecord>
  eventsHead(): Promise<EventsHeadResponse>
  lifecycleEvents(input: {
    eventKind: string
    runtimeId: string
    limit: number
  }): Promise<readonly HrcLifecycleEvent[]>
  brokerEventsQuery(op: BrokerEventsQueryOp): Promise<BrokerEventsQueryResponse>
  localPlacementBindings(): Promise<ListPlacementBindingsResponse>
  locate(scopeRef: string): Promise<ForeignHome | undefined>
  unbornDesignations(): Promise<ListUnbornDesignationsResponse>
  subscribeLifecycle(input: {
    afterSeq: number
    onEvent(event: HrcLifecycleEvent): void
  }): Promise<() => void | Promise<void>>
  subscribeBroker(input: {
    afterCommit: number
    onEvent(event: HrcBrokerInvocationEventRecord): void
  }): Promise<() => void | Promise<void>>
  steer(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: InjectionDispatchOptions
  ): Promise<InjectionDispatchResult>
  enqueue(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: InjectionDispatchOptions
  ): Promise<InjectionDispatchResult>
  invoke(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: InjectionDispatchOptions
  ): Promise<InjectionDispatchResult>
  preempt(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: InjectionDispatchOptions
  ): Promise<InjectionDispatchResult>
  preemptAdmission(
    session: HrcSessionRecord,
    request: PreemptSubmissionRequest
  ): Promise<PreemptAdmission>
}

/** State owned by the external injector, never by HRC. */
export type InjectorStateStore = {
  mailDelivery: HrcMailDeliveryRepository
  wrkqLedgerCursors: WrkqLedgerCursorRepository
  /** Latest bounded injector evidence; never delivery authority. */
  driveDiagnostics: InjectorDriveDiagnostics
  close(): void
}

export type InjectorProbeDiagnostic = Readonly<{
  boundary: 'broker_probe'
  code: string
  message: string
  phase: 'seat_probe'
  retryable: boolean | null
  transport: string | null
  missing: boolean
}>

export type InjectorDriveDiagnostic = Readonly<{
  envelopeId: string
  driveAttemptId: string
  targetSessionRef: string
  wakeReason: string
  outcome: string
  observedSeatState: string | null
  runtimeId: string | null
  invocationId: string | null
  diagnostic: InjectorProbeDiagnostic | null
  priorDriveAttemptId: string | null
  recoveredAt: string | null
  createdAt: string
}>

export type InjectorDriveDiagnostics = {
  latest(envelopeId: string): InjectorDriveDiagnostic | undefined
  record(input: Omit<InjectorDriveDiagnostic, 'createdAt'>): InjectorDriveDiagnostic
}

/** A live private Phase-3 state database to import into injector ownership. */
export type InjectorStateImport = {
  sourcePath: string
}

export type HrcDeliveryPosture = 'in-process' | 'disabled' | 'absent'

/**
 * Fail closed at the ownership boundary. An injector can never be started
 * beside an in-process HRC delivery owner.
 */
export function assertInjectorAdmissible(
  posture: HrcDeliveryPosture
): asserts posture is 'disabled' | 'absent' {
  if (posture === 'in-process') {
    throw new Error('HRC still owns in-process mail delivery; injector admission refused')
  }
}

export type InjectorBrokerPort = {
  seatProbe(runtimeId: string): Promise<InjectionRpcResult<SeatProbeResponse>>
}
