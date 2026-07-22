import { Database } from 'bun:sqlite'
import type { InterfaceStore } from 'acp-interface-store'
import type { JobsStore } from 'acp-jobs-store'
import { normalizeSessionRef } from 'agent-scope'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { toCompletedVisibleAssistantMessage } from '../delivery/visible-assistant-messages.js'
import type { AcpHrcClient, ConversationStore } from '../deps.js'
import type { RunStore, StoredRun } from '../domain/run-store.js'
import {
  type SemanticMessageCorrelation,
  type SemanticMessageFailure,
  type SemanticMessageResponse,
  metadataWithSemanticMessageTerminal,
  normalizeSemanticMessageDeliveryFailure,
  readSemanticMessageCorrelation,
  semanticMessageResponse,
  semanticMessageTimeoutFailure,
} from '../domain/semantic-message-run.js'
import { readOptionalTrimmedRawString as readString } from '../internal/read-helpers.js'
import { emitDispatchTimeoutHealthEvent } from '../jobs/health-dispatch-timeout.js'
import { isRecord } from '../parsers/body.js'
import {
  hasInFlightHrcRunSince,
  launchCorrelationUntilIso,
  mapHrcRunTerminalStatus,
  readCompletedAssistantMessageAfterSeq,
  readCompletedAssistantMessageFromHrcEvents,
  readRunStatus,
} from '../real-launcher.js'
import {
  hasExpiredTerminalCorrelationGrace,
  protectWithTerminalCorrelationGrace,
} from './dispatch-timeout-terminal-grace.js'

export type InterfaceRunDispatcherConfig = {
  intervalMs: number
  staleTimeoutMs: number
  dispatchStaleTimeoutMs?: number | undefined
  terminalCorrelationGraceMs?: number | undefined
}

export type InterfaceRunDispatcherInput = {
  runStore: RunStore
  interfaceStore: InterfaceStore
  jobsStore?: JobsStore | undefined
  conversationStore?: ConversationStore | undefined
  hrcClient?: Pick<AcpHrcClient, 'waitMessage'> | undefined
  hrcDbPath: string
  config: InterfaceRunDispatcherConfig
}

export type InterfaceRunDispatcher = {
  start(): void
  stop(): Promise<void>
  runOnce(): Promise<void>
}

type InterfaceRunSource = {
  gatewayId: string
  bindingId: string
  conversationRef: string
  threadRef?: string | undefined
  messageRef: string
  replyToMessageRef?: string | undefined
}

type RunReconciliationRoute =
  | { kind: 'semantic-message'; correlation: SemanticMessageCorrelation }
  | { kind: 'hrc-run' }
  | { kind: 'interface-session' }
  | { kind: 'unsupported' }

function classifyRunReconciliation(
  run: StoredRun,
  source: InterfaceRunSource | undefined
): RunReconciliationRoute {
  // Semantic message correlation is a first-class run transport. It
  // intentionally has neither a local HRC run id nor, for plain /v1/inputs,
  // an interface delivery target, so it must be classified before either
  // optional field can filter the run out.
  const semanticCorrelation = readSemanticMessageCorrelation(run)
  if (semanticCorrelation !== undefined) {
    return { kind: 'semantic-message', correlation: semanticCorrelation }
  }
  if (run.hrcRunId !== undefined) {
    return { kind: 'hrc-run' }
  }
  if (source !== undefined) {
    return { kind: 'interface-session' }
  }
  return { kind: 'unsupported' }
}

export function createInterfaceRunDispatcher(
  input: InterfaceRunDispatcherInput
): InterfaceRunDispatcher {
  const { runStore, interfaceStore, jobsStore, conversationStore, hrcClient, hrcDbPath, config } =
    input

  let running = false
  let inflight: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  async function runOnce(): Promise<void> {
    const pendingRuns = runStore.listRunsByStatus('pending')
    const runningRuns = runStore.listRunsByStatus('running')
    const completedRunsMissingFinalDelivery = runStore
      .listRunsByStatus('completed')
      .filter((run) => readInterfaceRunSource(run) !== undefined && !hasFinalDelivery(run.runId))
    const runs = [...pendingRuns, ...runningRuns, ...completedRunsMissingFinalDelivery]

    for (const run of runs) {
      try {
        await reconcileRun(run)
      } catch (error) {
        console.error(
          `[interface-run-dispatcher] error reconciling run ${run.runId}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  async function reconcileRun(run: StoredRun): Promise<void> {
    const source = readInterfaceRunSource(run)
    const route = classifyRunReconciliation(run, source)
    if (route.kind === 'semantic-message') {
      return reconcileFederatedRun(run, source, route.correlation)
    }
    if (route.kind === 'unsupported') {
      return
    }

    // Determine which resolution path to use based on available correlation data
    let assistantMessage: UnifiedSessionEvent | undefined
    let terminalFailureStatus: 'failed' | 'cancelled' | undefined
    let errorCode: string | undefined
    let errorMessage: string | undefined

    // Pending runs that have not yet recorded an hrcRunId are too early to
    // extract assistant content from. Even if hostSessionId is set (real-launcher
    // writes it before HRC accepts the turn), readAssistantMessageAfterSeq with
    // afterHrcSeq=0 would return the oldest message in the session — typically
    // a leftover preamble from a prior run. Either fail with dispatch_timeout
    // (if stale and HRC has no evidence the launch happened) or wait for the
    // next tick when hrcRunId arrives.
    if (run.status === 'pending' && run.hrcRunId === undefined) {
      const dispatchStaleTimeoutMs =
        config.dispatchStaleTimeoutMs ?? Math.min(config.staleTimeoutMs, 45_000)
      if (isStale(run, dispatchStaleTimeoutMs) || hasExpiredTerminalCorrelationGrace(run)) {
        // SDK-headless dispatchTurn blocks until the HRC turn completes, so a
        // long-running turn can leave the ACP run pending+no-hrcRunId well past
        // the dispatch timeout even though HRC accepted and is actively
        // processing it. Treat an IN-FLIGHT HRC run accepted on the same host
        // session within a bounded window after this ACP run was created as
        // evidence the launch is still working. The in-flight bound is essential:
        // once the correlated HRC run is TERMINAL but this ACP run is still
        // pending+no-hrcRunId, the write-back was permanently lost and the
        // phantom must be failed, not protected (T-04935). The window bound is
        // likewise essential: without it, an UNRELATED turn dispatched hours
        // later keeps a long-dead pending run alive (T-04297 follow-up).
        const launchObserved =
          run.hostSessionId !== undefined &&
          hasInFlightHrcRunSince(
            hrcDbPath,
            run.hostSessionId,
            run.createdAt,
            launchCorrelationUntilIso(run.createdAt)
          )
        const terminalGraceProtected =
          !launchObserved &&
          protectWithTerminalCorrelationGrace({
            run,
            runStore,
            hrcDbPath,
            config,
          })
        if (!launchObserved && !terminalGraceProtected) {
          terminalFailureStatus = 'failed'
          errorCode = 'dispatch_timeout'
          errorMessage = `Run was accepted by ACP but no HRC launch correlation was recorded within ${Math.round(dispatchStaleTimeoutMs / 1000)}s`
        }
      }
      return handleFailureOrSkip(run, source, terminalFailureStatus, errorCode, errorMessage)
    }

    if (run.hrcRunId !== undefined) {
      // Headless path: check HRC run status via turn.completed events
      const hrcStatus = readRunStatus(hrcDbPath, run.hrcRunId)
      if (hrcStatus === undefined) {
        // HRC run not found or not terminal yet — check for stale timeout
        if (isStale(run, config.staleTimeoutMs, hrcDbPath)) {
          terminalFailureStatus = 'failed'
          errorCode = 'turn_timeout'
          errorMessage = `Run exceeded stale timeout (${Math.round(config.staleTimeoutMs / 1000)}s) with no HRC completion`
        }
        return handleFailureOrSkip(run, source, terminalFailureStatus, errorCode, errorMessage)
      }

      const terminalOutcome = mapHrcRunTerminalStatus(hrcStatus)
      if (terminalOutcome?.status === 'completed') {
        assistantMessage = readCompletedAssistantMessageFromHrcEvents(hrcDbPath, run.hrcRunId)
      } else if (terminalOutcome !== undefined) {
        terminalFailureStatus = terminalOutcome.status
        errorCode = terminalOutcome.status === 'failed' ? 'turn_failed' : hrcStatus.errorCode
        errorMessage =
          hrcStatus.errorMessage ?? `HRC run ${run.hrcRunId} ended with status: ${hrcStatus.status}`
      } else {
        // Not terminal yet — check stale
        if (isStale(run, config.staleTimeoutMs, hrcDbPath)) {
          terminalFailureStatus = 'failed'
          errorCode = 'turn_timeout'
          errorMessage = `Run exceeded stale timeout (${Math.round(config.staleTimeoutMs / 1000)}s) with no HRC completion`
        }
        return handleFailureOrSkip(run, source, terminalFailureStatus, errorCode, errorMessage)
      }
    } else if (source !== undefined && run.hostSessionId !== undefined) {
      // Tmux path: live-progress delivery owns in-flight rendering. Do not
      // treat the first assistant message as final; multi-step agentic turns
      // can emit many turn.message events and can pause on interactive tools
      // without turn.completed. Final delivery is only safe after completion.
      const sessionRef = normalizeSessionRef({ scopeRef: run.scopeRef, laneRef: run.laneRef })
      const afterSeq = run.afterHrcSeq ?? 0

      assistantMessage = readCompletedAssistantMessageAfterSeq({
        hrcDbPath,
        hostSessionId: run.hostSessionId,
        sessionRef,
        afterHrcSeq: afterSeq,
      })

      if (assistantMessage === undefined) {
        // No assistant message yet — check stale timeout
        if (isStale(run, config.staleTimeoutMs, hrcDbPath)) {
          terminalFailureStatus = 'failed'
          errorCode = 'turn_timeout'
          errorMessage = `Run exceeded stale timeout (${Math.round(config.staleTimeoutMs / 1000)}s) with no assistant response`
        }
        return handleFailureOrSkip(run, source, terminalFailureStatus, errorCode, errorMessage)
      }
    } else {
      // No correlation data — likely dispatch failed before persisting. Check stale.
      if (isStale(run, config.staleTimeoutMs, hrcDbPath)) {
        terminalFailureStatus = 'failed'
        errorCode = 'turn_timeout'
        errorMessage = 'Run has no HRC correlation and exceeded stale timeout'
        return handleFailureOrSkip(run, source, terminalFailureStatus, errorCode, errorMessage)
      }
      return
    }

    if (terminalFailureStatus !== undefined) {
      return handleFailureOrSkip(run, source, terminalFailureStatus, errorCode, errorMessage)
    }

    finalizeSuccessfulRun(run, source, assistantMessage)
  }

  async function reconcileFederatedRun(
    run: StoredRun,
    source: InterfaceRunSource | undefined,
    correlation: SemanticMessageCorrelation
  ): Promise<void> {
    const reconciliation = await reconcileSemanticMessage({
      run,
      correlation,
      hrcClient,
      staleTimeoutMs: config.staleTimeoutMs,
    })
    const current = runStore.getRun(run.runId)
    if (current === undefined || (current.status !== 'pending' && current.status !== 'running')) {
      // Cancellation and any competing terminal transition win over a response
      // that arrives while waitMessage is yielding to HRC.
      return
    }
    if (reconciliation.state === 'pending') {
      return
    }
    if (reconciliation.state === 'failed') {
      handleFailureOrSkip(
        run,
        source,
        'failed',
        reconciliation.error.code,
        reconciliation.error.message,
        metadataWithSemanticMessageTerminal(current, {
          state: 'failed',
          error: reconciliation.error,
        })
      )
      return
    }

    finalizeSuccessfulRun(
      run,
      source,
      reconciliation.event,
      metadataWithSemanticMessageTerminal(current, {
        state: 'completed',
        response: reconciliation.response,
      })
    )
  }

  function finalizeSuccessfulRun(
    run: StoredRun,
    source: InterfaceRunSource | undefined,
    assistantMessage: UnifiedSessionEvent | undefined,
    metadata?: Readonly<Record<string, unknown>> | undefined
  ): void {
    // Success path: enqueue delivery + mark run completed.
    if (assistantMessage !== undefined && source !== undefined) {
      const visible = toCompletedVisibleAssistantMessage(assistantMessage)
      if (visible !== undefined) {
        if (hasFinalDelivery(run.runId)) {
          return
        }

        const deliveryRequestId = createDeliveryRequestId(run.runId, 1)
        const createdAt = new Date().toISOString()
        try {
          interfaceStore.runInTransaction((store) => {
            const pendingAttachments = store.outboundAttachments.listPendingForRun(run.runId)
            const bodyAttachments = pendingAttachments.map((a) => ({
              kind: 'file' as const,
              path: a.path,
              filename: a.filename,
              contentType: a.contentType,
              sizeBytes: a.sizeBytes,
              ...(a.alt !== undefined ? { alt: a.alt } : {}),
            }))

            store.deliveries.enqueue({
              deliveryRequestId,
              actor: run.actor,
              gatewayId: source.gatewayId,
              bindingId: source.bindingId,
              scopeRef: run.scopeRef,
              laneRef: run.laneRef,
              runId: run.runId,
              conversationRef: source.conversationRef,
              ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
              ...(source.replyToMessageRef !== undefined
                ? { replyToMessageRef: source.replyToMessageRef }
                : {}),
              bodyKind: 'text/markdown',
              bodyText: visible.text,
              ...(visible.outcome !== undefined ? { outcome: visible.outcome } : {}),
              ...(bodyAttachments.length > 0 ? { bodyAttachments } : {}),
              createdAt,
            })

            if (pendingAttachments.length > 0) {
              store.outboundAttachments.markConsumedForRun(run.runId, deliveryRequestId, createdAt)
            }
          })
        } catch (error) {
          // If delivery already exists (duplicate primary key), this is idempotent — skip
          if (isUniqueConstraintError(error)) {
            // Already delivered — just mark completed below
          } else {
            throw error
          }
        }

        // Create assistant conversation turn if conversation store is available
        if (conversationStore !== undefined) {
          try {
            const thread = conversationStore.createOrGetThread({
              gatewayId: source.gatewayId,
              conversationRef: source.conversationRef,
              ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
              sessionRef: normalizeSessionRef({ scopeRef: run.scopeRef, laneRef: run.laneRef }),
              audience: 'human',
            })

            const turnId = conversationStore.createTurn({
              threadId: thread.threadId,
              role: 'assistant',
              body: visible.text,
              renderState: 'pending',
              links: { runId: run.runId },
              actor: run.actor,
              sentAt: createdAt,
            })

            conversationStore.attachLinks(turnId, { deliveryRequestId })
          } catch (error) {
            console.error(
              `[interface-run-dispatcher] conversation turn creation failed for run ${run.runId}:`,
              error instanceof Error ? error.message : String(error)
            )
          }
        }
      }
    }

    runStore.updateRun(run.runId, {
      status: 'completed',
      errorCode: null,
      errorMessage: null,
      ...(metadata !== undefined ? { metadata } : {}),
    })
  }

  function hasFinalDelivery(runId: string): boolean {
    return interfaceStore.deliveries
      .listByRun(runId)
      .some((delivery) => !delivery.deliveryRequestId.includes('_oob_'))
  }

  function handleFailureOrSkip(
    run: StoredRun,
    source: InterfaceRunSource | undefined,
    terminalStatus: 'failed' | 'cancelled' | undefined,
    errorCode: string | undefined,
    errorMessage: string | undefined,
    metadata?: Readonly<Record<string, unknown>> | undefined
  ): void {
    if (terminalStatus === undefined) {
      return
    }

    const terminalRun = runStore.updateRun(run.runId, {
      status: terminalStatus,
      errorCode,
      errorMessage,
      ...(metadata !== undefined ? { metadata } : {}),
    })
    if (terminalStatus === 'failed' && errorCode === 'dispatch_timeout') {
      emitDispatchTimeoutHealthEvent({
        jobsStore,
        run: terminalRun,
        originVia: 'interface-run-dispatcher',
      })
    }

    // Enqueue an error delivery so the gateway can replace the placeholder
    if (source !== undefined) {
      const deliveryRequestId = createDeliveryRequestId(run.runId, 1)
      const createdAt = new Date().toISOString()
      const bodyText =
        terminalStatus === 'cancelled'
          ? 'The agent run was cancelled.'
          : errorCode === 'dispatch_timeout'
            ? `The request was accepted by ACP, but no agent run started before dispatch timeout. ACP run ${run.runId} is stuck before HRC launch${errorMessage !== undefined ? `: ${errorMessage}` : '.'}`
            : errorCode === 'turn_timeout'
              ? 'The agent timed out processing this request. The response may still be in progress — check back shortly.'
              : `The agent encountered an error: ${errorMessage ?? 'unknown failure'}`

      try {
        interfaceStore.deliveries.enqueue({
          deliveryRequestId,
          actor: run.actor,
          gatewayId: source.gatewayId,
          bindingId: source.bindingId,
          scopeRef: run.scopeRef,
          laneRef: run.laneRef,
          runId: run.runId,
          conversationRef: source.conversationRef,
          ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
          ...(source.replyToMessageRef !== undefined
            ? { replyToMessageRef: source.replyToMessageRef }
            : {}),
          bodyKind: 'text/markdown',
          bodyText,
          createdAt,
        })
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          console.error(
            `[interface-run-dispatcher] failed to enqueue error delivery for run ${run.runId}:`,
            error instanceof Error ? error.message : String(error)
          )
        }
      }
    }
  }

  function scheduleNext(): void {
    if (!running) {
      return
    }

    timer = setTimeout(() => {
      if (!running) {
        return
      }

      const pass = runOnce()
      inflight = pass
      void pass
        .catch((error) => {
          console.error(
            '[interface-run-dispatcher] loop error:',
            error instanceof Error ? error.message : String(error)
          )
        })
        .then(() => {
          inflight = undefined
          scheduleNext()
        })
    }, config.intervalMs)
  }

  function start(): void {
    running = true

    // Startup sweep: immediately reconcile any runs that were left running
    const pass = runOnce()
    inflight = pass
    void pass
      .catch((error) => {
        console.error(
          '[interface-run-dispatcher] startup sweep error:',
          error instanceof Error ? error.message : String(error)
        )
      })
      .then(() => {
        inflight = undefined
        scheduleNext()
      })
  }

  async function stop(): Promise<void> {
    running = false

    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    if (inflight !== undefined) {
      await inflight
    }
  }

  return { start, stop, runOnce }
}

type SemanticMessageReconciliation =
  | { state: 'pending' }
  | { state: 'response'; event: UnifiedSessionEvent; response: SemanticMessageResponse }
  | { state: 'failed'; error: SemanticMessageFailure }

async function reconcileSemanticMessage(input: {
  run: StoredRun
  correlation: SemanticMessageCorrelation
  hrcClient: Pick<AcpHrcClient, 'waitMessage'> | undefined
  staleTimeoutMs: number
}): Promise<SemanticMessageReconciliation> {
  if (input.hrcClient === undefined) {
    throw new Error(
      `run ${input.run.runId} has HRC semantic correlation but no HRC client is configured`
    )
  }

  const waited = await input.hrcClient.waitMessage({
    thread: { rootMessageId: input.correlation.rootMessageId },
    kinds: ['dm'],
    phases: ['response'],
    afterSeq: input.correlation.afterSeq,
    deliveryMessageId: input.correlation.requestMessageId,
    timeoutMs: 1,
  })
  if (waited.matched) {
    logFederatedInterfaceEvent('response', {
      acpRunId: input.run.runId,
      scopeRef: input.run.scopeRef,
      laneRef: input.run.laneRef,
      requestMessageId: input.correlation.requestMessageId,
      responseMessageId: waited.record.messageId,
      localNodeId: input.correlation.localNodeId,
      homeNodeId: input.correlation.homeNodeId,
    })
    return {
      state: 'response',
      response: semanticMessageResponse(waited.record),
      event: {
        type: 'message_end',
        messageId: waited.record.messageId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: waited.record.body }],
        },
      },
    }
  }

  if (waited.reason === 'delivery_failed') {
    const typedFailure = waited as typeof waited & {
      errorReason?: string | undefined
      retryable?: boolean | undefined
      homeNodeId?: string | undefined
    }
    const error = normalizeSemanticMessageDeliveryFailure({
      errorCode: waited.errorCode,
      ...(waited.errorMessage !== undefined ? { errorMessage: waited.errorMessage } : {}),
      ...(typedFailure.errorReason !== undefined ? { errorReason: typedFailure.errorReason } : {}),
      ...(typedFailure.retryable !== undefined ? { retryable: typedFailure.retryable } : {}),
      ...(typedFailure.homeNodeId !== undefined ? { homeNodeId: typedFailure.homeNodeId } : {}),
      ...(input.correlation.homeNodeId !== undefined
        ? { fallbackHomeNodeId: input.correlation.homeNodeId }
        : {}),
    })
    logFederatedInterfaceEvent('delivery_failed', {
      acpRunId: input.run.runId,
      scopeRef: input.run.scopeRef,
      laneRef: input.run.laneRef,
      requestMessageId: input.correlation.requestMessageId,
      localNodeId: input.correlation.localNodeId,
      errorCode: error.code,
      errorMessage: error.message,
      errorReason: error.reason,
      retryable: error.retryable,
      homeNodeId: error.homeNodeId,
    })
    return { state: 'failed', error }
  }

  if (isStale(input.run, input.staleTimeoutMs)) {
    const message = `Federated HRC message ${input.correlation.requestMessageId} exceeded stale timeout (${Math.round(input.staleTimeoutMs / 1000)}s) without a response`
    return {
      state: 'failed',
      error: semanticMessageTimeoutFailure({
        message,
        ...(input.correlation.homeNodeId !== undefined
          ? { homeNodeId: input.correlation.homeNodeId }
          : {}),
      }),
    }
  }
  return { state: 'pending' }
}

function logFederatedInterfaceEvent(
  phase: 'response' | 'delivery_failed',
  fields: Readonly<Record<string, unknown>>
): void {
  console.info(
    `[interface-run-dispatcher] ${JSON.stringify({ event: `interface.federation.${phase}`, ...fields })}`
  )
}

function isStale(run: StoredRun, staleTimeoutMs: number, hrcDbPath?: string): boolean {
  const activityAt =
    hrcDbPath === undefined
      ? parseTimestampMs(run.updatedAt, Date.now())
      : lastObservedActivityMs(run, hrcDbPath)
  return Date.now() - activityAt > staleTimeoutMs
}

export function lastObservedActivityMs(run: StoredRun, hrcDbPath: string): number {
  const now = Date.now()
  const runUpdatedAt = parseTimestampMs(run.updatedAt, now)

  if (run.status === 'pending' && run.hrcRunId === undefined) {
    return runUpdatedAt
  }

  const hrcEventAt = readLastCorrelatedHrcEventMs(run, hrcDbPath, now)
  return hrcEventAt === undefined ? runUpdatedAt : Math.max(runUpdatedAt, hrcEventAt)
}

function readLastCorrelatedHrcEventMs(
  run: StoredRun,
  hrcDbPath: string,
  now: number
): number | undefined {
  const correlation = buildHrcActivityQuery(run)
  if (correlation === undefined) {
    return undefined
  }

  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const row = db
      .query<{ ts: string }, Array<string | number>>(correlation.sql)
      .get(...correlation.params)
    if (row === null || row === undefined) {
      return undefined
    }

    const parsed = Date.parse(row.ts)
    if (!Number.isFinite(parsed)) {
      return undefined
    }

    return Math.min(parsed, now)
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

function buildHrcActivityQuery(
  run: StoredRun
): { sql: string; params: Array<string | number> } | undefined {
  if (run.hrcRunId !== undefined) {
    const clauses = ['run_id = ?']
    const params: Array<string | number> = [run.hrcRunId]

    if (run.hostSessionId !== undefined) {
      clauses.push('host_session_id = ?')
      params.push(run.hostSessionId)
    }

    if (run.generation !== undefined) {
      clauses.push('generation = ?')
      params.push(run.generation)
    }

    return {
      sql: `SELECT ts
        FROM hrc_events
        WHERE ${clauses.join(' AND ')}
        ORDER BY hrc_seq DESC
        LIMIT 1`,
      params,
    }
  }

  if (run.hostSessionId === undefined) {
    return undefined
  }

  const clauses = ['host_session_id = ?', 'scope_ref = ?', 'lane_ref = ?', 'hrc_seq > ?']
  const params: Array<string | number> = [
    run.hostSessionId,
    run.scopeRef,
    run.laneRef,
    run.afterHrcSeq ?? 0,
  ]

  if (run.generation !== undefined) {
    clauses.push('generation = ?')
    params.push(run.generation)
  }

  return {
    sql: `SELECT ts
      FROM hrc_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY hrc_seq DESC
      LIMIT 1`,
    params,
  }
}

function parseTimestampMs(value: string, fallback: number): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readInterfaceRunSource(run: StoredRun): InterfaceRunSource | undefined {
  const metadata = run.metadata
  if (!isRecord(metadata)) {
    return undefined
  }

  const meta = metadata['meta']
  if (!isRecord(meta)) {
    return undefined
  }

  const interfaceSource = meta['interfaceSource']
  if (!isRecord(interfaceSource)) {
    return undefined
  }

  const gatewayId = readString(interfaceSource, 'gatewayId')
  const bindingId = readString(interfaceSource, 'bindingId')
  const conversationRef = readString(interfaceSource, 'conversationRef')
  const messageRef = readString(interfaceSource, 'messageRef')

  if (
    gatewayId === undefined ||
    bindingId === undefined ||
    conversationRef === undefined ||
    messageRef === undefined
  ) {
    return undefined
  }

  const threadRef = readString(interfaceSource, 'threadRef')
  const replyToMessageRef = readString(interfaceSource, 'replyToMessageRef')

  return {
    gatewayId,
    bindingId,
    conversationRef,
    ...(threadRef !== undefined ? { threadRef } : {}),
    messageRef,
    ...(replyToMessageRef !== undefined ? { replyToMessageRef } : {}),
  }
}

function createDeliveryRequestId(runId: string, ordinal: number): string {
  // Deterministic ID so the dispatcher is idempotent across loops/restarts
  return `dr_${runId}_dispatch_${ordinal.toString().padStart(4, '0')}`
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}
