import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type SessionRef, parseScopeRef } from 'agent-scope'
import {
  HrcConflictError,
  type HrcEventEnvelope,
  type HrcHarnessIntent,
  type HrcRuntimeIntent,
  resolveDatabasePath,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { parseAgentProfile, resolveHarnessCatalogEntry } from 'spaces-config'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import type { LaunchRoleScopedRun, RunStore } from './deps.js'
import type { DispatchFence, UpdateRunInput } from './domain/run-store.js'

const DEFAULT_WAIT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 500
const RAW_EVENT_POLL_INTERVAL_MS = 100
const RAW_EVENT_POLL_GRACE_MS = 2_000
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const UNAVAILABLE_TMUX_STATUSES = new Set(['terminated', 'stale', 'failed', 'exited'])

export type RawRunEventRecord = Pick<HrcEventEnvelope, 'eventKind' | 'eventJson'>

type LiveTmuxRuntime = {
  hostSessionId: string
  runtimeId: string
}

type RealLauncherOptions = {
  socketPath?: string | undefined
  hrcDbPath?: string | undefined
  watchTimeoutMs?: number | undefined
  pollIntervalMs?: number | undefined
  createClient?: ((socketPath: string) => HrcClient) | undefined
}

export function createRealLauncher(options: RealLauncherOptions = {}): LaunchRoleScopedRun {
  const socketPath = options.socketPath ?? discoverSocket()
  const hrcDbPath = options.hrcDbPath ?? resolveDatabasePath()
  const createClient = options.createClient ?? ((path: string) => new HrcClient(path))
  const waitTimeoutMs = options.watchTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  return async ({
    sessionRef,
    intent,
    acpRunId,
    inputAttemptId,
    runStore,
    onEvent,
    waitForCompletion,
  }) => {
    const client = createClient(socketPath)
    const liveTmuxRuntime = findLiveTmuxRuntimeForSessionRef(hrcDbPath, sessionRef)
    const launchIntent = withAcpLaunchContextEnv(intent, { acpRunId, inputAttemptId, runStore })
    const normalizedIntent = normalizeRealLauncherIntent({
      sessionRef,
      intent: launchIntent,
      liveTmuxRuntime: liveTmuxRuntime !== undefined,
    })
    const acpCorrelationId = acpRunId ?? inputAttemptId
    const shouldWaitForCompletion = onEvent !== undefined && waitForCompletion !== false
    const prompt = normalizedIntent.initialPrompt?.trim()
    if (!prompt) {
      const resolved = await client.resolveSession({
        sessionRef: toHrcSessionRef(sessionRef),
        runtimeIntent: normalizedIntent,
      })
      updateAcpRun(runStore, acpRunId, {
        hostSessionId: resolved.hostSessionId,
        generation: resolved.generation,
        ...(liveTmuxRuntime !== undefined
          ? {
              runtimeId: liveTmuxRuntime.runtimeId,
              transport: 'tmux',
            }
          : {}),
      })
      return {
        runId: resolved.hostSessionId,
        sessionId: resolved.hostSessionId,
        hostSessionId: resolved.hostSessionId,
        ...(liveTmuxRuntime !== undefined ? { runtimeId: liveTmuxRuntime.runtimeId } : {}),
        ...(liveTmuxRuntime !== undefined
          ? {
              launchId: findLatestLaunchId(hrcDbPath, {
                hostSessionId: resolved.hostSessionId,
                runtimeId: liveTmuxRuntime.runtimeId,
              }),
            }
          : {}),
        generation: resolved.generation,
      }
    }

    const resolved = await client.resolveSession({
      sessionRef: toHrcSessionRef(sessionRef),
      runtimeIntent: normalizedIntent,
    })
    const dispatchFence = resolveDispatchFence({
      acpRunId,
      runStore,
      hostSessionId: resolved.hostSessionId,
      generation: resolved.generation,
    })

    updateAcpRun(runStore, acpRunId, {
      hostSessionId: resolved.hostSessionId,
      generation: resolved.generation,
      ...(liveTmuxRuntime !== undefined
        ? {
            runtimeId: liveTmuxRuntime.runtimeId,
            transport: 'tmux',
          }
        : {}),
    })
    setAcpDispatchFence(runStore, acpRunId, dispatchFence)

    if (liveTmuxRuntime !== undefined) {
      const latestAssistantSeq = readLatestAssistantMessageSeq(hrcDbPath, {
        hostSessionId: liveTmuxRuntime.hostSessionId,
        sessionRef,
      })
      try {
        await client.deliverLiteralBySelector({
          selector: { sessionRef: toHrcSessionRef(sessionRef) },
          text: prompt,
          enter: false,
          fences: dispatchFence,
        })
      } catch (error) {
        persistFenceDispatchError(runStore, acpRunId, error)
        throw error
      }
      await Bun.sleep(200)
      let delivered: Awaited<ReturnType<typeof client.deliverLiteralBySelector>>
      try {
        delivered = await client.deliverLiteralBySelector({
          selector: { sessionRef: toHrcSessionRef(sessionRef) },
          text: '',
          enter: true,
          fences: dispatchFence,
        })
      } catch (error) {
        persistFenceDispatchError(runStore, acpRunId, error)
        throw error
      }

      updateAcpRun(runStore, acpRunId, {
        status: 'running',
        hostSessionId: delivered.hostSessionId,
        generation: delivered.generation,
        runtimeId: delivered.runtimeId ?? liveTmuxRuntime.runtimeId,
        transport: 'tmux',
        afterHrcSeq: latestAssistantSeq,
      })

      if (shouldWaitForCompletion && onEvent !== undefined) {
        const assistantMessage = await pollAssistantMessageAfterSeq({
          hrcDbPath,
          hostSessionId: delivered.hostSessionId,
          sessionRef,
          afterHrcSeq: latestAssistantSeq,
          timeoutMs: waitTimeoutMs,
        })
        if (assistantMessage === undefined) {
          throw new Error(
            `HRC tmux runtime ${delivered.runtimeId ?? liveTmuxRuntime.runtimeId} did not produce an assistant reply event${acpCorrelationId !== undefined ? ` for ${acpCorrelationId}` : ''}`
          )
        }
        await onEvent(assistantMessage)
        updateAcpRun(runStore, acpRunId, { status: 'completed' })
      }

      return {
        runId: delivered.hostSessionId,
        sessionId: delivered.hostSessionId,
        hostSessionId: delivered.hostSessionId,
        runtimeId: delivered.runtimeId ?? liveTmuxRuntime.runtimeId,
        launchId: findLatestLaunchId(hrcDbPath, {
          hostSessionId: delivered.hostSessionId,
          runtimeId: delivered.runtimeId ?? liveTmuxRuntime.runtimeId,
        }),
        generation: delivered.generation,
      }
    }

    const targetSession = resolved
    let dispatched: Awaited<ReturnType<typeof client.dispatchTurn>>
    try {
      dispatched = await client.dispatchTurn({
        hostSessionId: targetSession.hostSessionId,
        prompt,
        ...(normalizedIntent.attachments !== undefined
          ? { attachments: normalizedIntent.attachments }
          : {}),
        fences: dispatchFence,
        runtimeIntent: normalizedIntent,
        waitForCompletion: shouldWaitForCompletion,
      })
    } catch (error) {
      persistFenceDispatchError(runStore, acpRunId, error)
      throw error
    }

    updateAcpRun(runStore, acpRunId, {
      hrcRunId: dispatched.runId,
      status: dispatched.status === 'completed' ? 'completed' : 'running',
      hostSessionId: dispatched.hostSessionId,
      generation: dispatched.generation,
      runtimeId: dispatched.runtimeId,
      transport: dispatched.transport,
    })

    if (shouldWaitForCompletion) {
      const completedRun =
        dispatched.status === 'completed'
          ? (readRunStatus(hrcDbPath, dispatched.runId) ?? { status: 'completed' })
          : await waitForRunCompletion({
              hrcDbPath,
              runId: dispatched.runId,
              timeoutMs: waitTimeoutMs,
              pollIntervalMs,
            })

      updateAcpRun(runStore, acpRunId, {
        hrcRunId: dispatched.runId,
        status: toAcpRunStatus(completedRun.status),
        errorCode: completedRun.errorCode,
        errorMessage: completedRun.errorMessage,
      })

      if (completedRun.status !== 'completed') {
        throw createHrcRunTerminalError(dispatched.runId, completedRun)
      }
    }

    if (shouldWaitForCompletion && onEvent !== undefined) {
      const completedAssistantMessage = await pollCompletedAssistantMessage({
        hrcDbPath,
        runId: dispatched.runId,
        timeoutMs: RAW_EVENT_POLL_GRACE_MS,
      })
      if (completedAssistantMessage === undefined) {
        throw new Error(
          `HRC run ${dispatched.runId} completed without an assistant reply event${acpCorrelationId !== undefined ? ` for ${acpCorrelationId}` : ''}`
        )
      }
      await onEvent(completedAssistantMessage)
    }

    return {
      runId: dispatched.runId,
      sessionId: targetSession.hostSessionId,
      hostSessionId: dispatched.hostSessionId,
      runtimeId: dispatched.runtimeId,
      launchId:
        findLaunchIdForRun(hrcDbPath, dispatched.runId) ??
        findLatestLaunchId(hrcDbPath, {
          hostSessionId: dispatched.hostSessionId,
          runtimeId: dispatched.runtimeId,
        }),
      generation: dispatched.generation,
    }
  }
}

function findLaunchIdForRun(hrcDbPath: string, runId: string): string | undefined {
  let db: Database | undefined
  try {
    db = new Database(hrcDbPath, { readonly: true })
    const row = db
      .query<{ launchId: string }, [string]>(
        `SELECT launch_id AS launchId
           FROM hrc_events
          WHERE run_id = ? AND launch_id IS NOT NULL
          ORDER BY hrc_seq ASC
          LIMIT 1`
      )
      .get(runId)
    return row?.launchId
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function findLatestLaunchId(
  hrcDbPath: string,
  input: { hostSessionId: string; runtimeId?: string | undefined }
): string | undefined {
  let db: Database | undefined
  try {
    db = new Database(hrcDbPath, { readonly: true })
    const row =
      input.runtimeId !== undefined
        ? db
            .query<{ launchId: string }, [string, string]>(
              `SELECT launch_id AS launchId
                 FROM launches
                WHERE host_session_id = ? AND runtime_id = ?
                ORDER BY created_at DESC, launch_id DESC
                LIMIT 1`
            )
            .get(input.hostSessionId, input.runtimeId)
        : db
            .query<{ launchId: string }, [string]>(
              `SELECT launch_id AS launchId
                 FROM launches
                WHERE host_session_id = ?
                ORDER BY created_at DESC, launch_id DESC
                LIMIT 1`
            )
            .get(input.hostSessionId)
    return row?.launchId
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function withAcpLaunchContextEnv(
  intent: HrcRuntimeIntent,
  input: {
    acpRunId?: string | undefined
    inputAttemptId?: string | undefined
    runStore?: RunStore | undefined
  }
): HrcRuntimeIntent {
  const env: Record<string, string> = {}
  if (input.acpRunId !== undefined) {
    env['ACP_RUN_ID'] = input.acpRunId
  }
  if (input.inputAttemptId !== undefined) {
    env['ACP_INPUT_ATTEMPT_ID'] = input.inputAttemptId
  }

  const run =
    input.acpRunId !== undefined && input.runStore !== undefined
      ? input.runStore.getRun(input.acpRunId)
      : undefined
  const interfaceSource = readInterfaceSourceFromRun(run)
  if (interfaceSource !== undefined) {
    env['ACP_INTERFACE_SOURCE'] = JSON.stringify(interfaceSource)
  }

  if (Object.keys(env).length === 0) {
    return intent
  }

  return {
    ...intent,
    launch: {
      ...intent.launch,
      env: {
        ...intent.launch?.env,
        ...env,
      },
    },
  }
}

function readInterfaceSourceFromRun(run: ReturnType<RunStore['getRun']>): unknown | undefined {
  const metadata = asRecord(run?.metadata)
  const meta = asRecord(metadata['meta'])
  const interfaceSource = meta['interfaceSource']
  return typeof interfaceSource === 'object' &&
    interfaceSource !== null &&
    !Array.isArray(interfaceSource)
    ? interfaceSource
    : undefined
}

export function normalizeRealLauncherIntent(input: {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
  liveTmuxRuntime?: boolean | undefined
}): HrcRuntimeIntent {
  const inferredHarness = input.intent.harness ?? inferHarnessIntent(input)
  const preferredMode = input.liveTmuxRuntime
    ? ('interactive' as const)
    : (input.intent.execution?.preferredMode ??
      (input.intent.harness !== undefined || inferredHarness.interactive
        ? ('headless' as const)
        : undefined))
  const normalizedExecution =
    preferredMode === undefined
      ? input.intent.execution
      : {
          ...input.intent.execution,
          preferredMode,
        }
  const harness = inferredHarness
  const normalizedHarness =
    preferredMode === 'interactive' ? { ...harness, interactive: true } : harness

  return {
    ...input.intent,
    placement: {
      ...input.intent.placement,
      ...(input.intent.placement.dryRun === undefined ? { dryRun: false } : {}),
    },
    harness: normalizedHarness,
    ...(normalizedExecution !== undefined ? { execution: normalizedExecution } : {}),
  }
}

export function toUnifiedAssistantMessageEndFromRawEvents(
  events: readonly RawRunEventRecord[]
): UnifiedSessionEvent | undefined {
  let explicitMessageEnd: UnifiedSessionEvent | undefined
  let assistantMessage: UnifiedSessionEvent | undefined
  let finalOutput: UnifiedSessionEvent | undefined
  let accumulatedDelta = ''

  for (const event of events) {
    const eventJson = asRecord(event.eventJson)
    const type = readString(eventJson, 'type')
    if (type === 'message_end') {
      const candidate = readAssistantMessageEndEvent(eventJson)
      if (candidate !== undefined) {
        explicitMessageEnd = candidate
      }
      continue
    }

    if (type === 'message' && readString(eventJson, 'role') === 'assistant') {
      const text = extractAssistantText(eventJson['content'])
      if (text !== undefined && text.trim().length > 0) {
        const messageId = readAssistantMessageId(eventJson)
        assistantMessage = {
          type: 'message_end',
          ...(messageId !== undefined ? { messageId } : {}),
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        }
      }
      continue
    }

    if (type === 'message_delta' && readString(eventJson, 'role') === 'assistant') {
      const delta = readString(eventJson, 'delta')
      if (delta !== undefined) {
        accumulatedDelta += delta
      }
      continue
    }

    if (type === 'complete') {
      const result = asRecord(eventJson['result'])
      const output = readString(result, 'finalOutput')
      if (output !== undefined && output.trim().length > 0) {
        finalOutput = {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: output }] },
        }
      }
    }
  }

  if (explicitMessageEnd !== undefined) {
    return explicitMessageEnd
  }
  if (assistantMessage !== undefined) {
    return assistantMessage
  }
  if (finalOutput !== undefined) {
    return finalOutput
  }
  if (accumulatedDelta.trim().length > 0) {
    return {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: accumulatedDelta }],
      },
    }
  }
  return undefined
}

async function waitForRunCompletion(options: {
  hrcDbPath: string
  runId: string
  timeoutMs: number
  pollIntervalMs: number
}): Promise<{
  status: string
  errorCode?: string | undefined
  errorMessage?: string | undefined
}> {
  const deadline = Date.now() + options.timeoutMs

  while (Date.now() <= deadline) {
    const run = readRunStatus(options.hrcDbPath, options.runId)
    if (run !== undefined && TERMINAL_RUN_STATUSES.has(run.status)) {
      return run
    }
    await Bun.sleep(options.pollIntervalMs)
  }

  throw new Error(`timed out waiting for HRC run ${options.runId} to complete`)
}

function updateAcpRun(
  runStore: RunStore | undefined,
  acpRunId: string | undefined,
  patch: UpdateRunInput
): void {
  if (runStore === undefined || acpRunId === undefined) {
    return
  }

  runStore.updateRun(acpRunId, patch)
}

function setAcpDispatchFence(
  runStore: RunStore | undefined,
  acpRunId: string | undefined,
  dispatchFence: DispatchFence
): void {
  if (runStore === undefined || acpRunId === undefined) {
    return
  }

  runStore.setDispatchFence(acpRunId, dispatchFence)
}

function resolveDispatchFence(input: {
  runStore?: RunStore | undefined
  acpRunId?: string | undefined
  hostSessionId: string
  generation: number
}): DispatchFence {
  const existingFence =
    input.runStore !== undefined && input.acpRunId !== undefined
      ? input.runStore.getRun(input.acpRunId)?.dispatchFence
      : undefined

  if (existingFence?.followLatest === true) {
    return { followLatest: true }
  }

  return {
    expectedHostSessionId: input.hostSessionId,
    ...(input.generation !== undefined ? { expectedGeneration: input.generation } : {}),
  }
}

function persistFenceDispatchError(
  runStore: RunStore | undefined,
  acpRunId: string | undefined,
  error: unknown
): void {
  if (!(error instanceof HrcConflictError)) {
    return
  }

  updateAcpRun(runStore, acpRunId, {
    status: 'failed',
    errorCode: error.code,
    errorMessage: error.message,
  })
}

function toAcpRunStatus(status: string): 'completed' | 'failed' | 'cancelled' {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    return status
  }

  return 'failed'
}

function createHrcRunTerminalError(
  runId: string,
  run: {
    status: string
    errorCode?: string | undefined
    errorMessage?: string | undefined
  }
): Error {
  const details = [run.errorCode, run.errorMessage].filter(Boolean).join(': ')
  return new Error(
    details.length > 0
      ? `HRC run ${runId} ended with status ${run.status}: ${details}`
      : `HRC run ${runId} ended with status ${run.status}`
  )
}

async function pollCompletedAssistantMessage(options: {
  hrcDbPath: string
  runId: string
  timeoutMs: number
}): Promise<UnifiedSessionEvent | undefined> {
  const deadline = Date.now() + options.timeoutMs

  while (Date.now() <= deadline) {
    const message = readCompletedAssistantMessageFromHrcEvents(options.hrcDbPath, options.runId)
    if (message !== undefined) {
      return message
    }
    await Bun.sleep(RAW_EVENT_POLL_INTERVAL_MS)
  }

  return readCompletedAssistantMessageFromHrcEvents(options.hrcDbPath, options.runId)
}

export function hasHrcAcceptedRunSince(
  hrcDbPath: string,
  hostSessionId: string,
  sinceIso: string
): boolean {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const row = db
      .query<{ runId: string }, [string, string]>(
        `SELECT run_id AS runId
          FROM runs
          WHERE host_session_id = ?
            AND accepted_at IS NOT NULL
            AND accepted_at >= ?
          LIMIT 1`
      )
      .get(hostSessionId, sinceIso)
    return row !== null && row !== undefined
  } catch {
    return false
  } finally {
    db.close()
  }
}

export function readRunStatus(
  hrcDbPath: string,
  runId: string
):
  | {
      status: string
      errorCode?: string | undefined
      errorMessage?: string | undefined
    }
  | undefined {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const row = db
      .query<{ status: string; errorCode: string | null; errorMessage: string | null }, [string]>(
        `SELECT status, error_code AS errorCode, error_message AS errorMessage
          FROM runs
          WHERE run_id = ?`
      )
      .get(runId)
    if (!row) {
      return undefined
    }
    return {
      status: row.status,
      ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
      ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    }
  } finally {
    db.close()
  }
}

export function listLegacyRawRunEvents(hrcDbPath: string, runId: string): RawRunEventRecord[] {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const rows = db
      .query<{ eventKind: string; eventJson: string }, [string]>(
        `SELECT event_kind AS eventKind, event_json AS eventJson
          FROM events
          WHERE run_id = ?
          ORDER BY seq ASC`
      )
      .all(runId)

    return rows.map((row) => ({
      eventKind: row.eventKind,
      eventJson: parseJson(row.eventJson),
    }))
  } finally {
    db.close()
  }
}

function findLiveTmuxRuntimeForSessionRef(
  hrcDbPath: string,
  sessionRef: SessionRef
): LiveTmuxRuntime | undefined {
  if (hrcDbPath === ':memory:') {
    return undefined
  }

  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const continuity = db
      .query<{ hostSessionId: string }, [string, string]>(
        `SELECT active_host_session_id AS hostSessionId
          FROM continuities
          WHERE scope_ref = ? AND lane_ref = ?`
      )
      .get(sessionRef.scopeRef, sessionRef.laneRef)
    const hostSessionId = continuity?.hostSessionId
    if (hostSessionId === undefined) {
      return undefined
    }

    const runtime = db
      .query<{ runtimeId: string; status: string }, [string]>(
        `SELECT runtime_id AS runtimeId, status
          FROM runtimes
          WHERE host_session_id = ?
            AND transport = 'tmux'
            AND tmux_json IS NOT NULL
          ORDER BY updated_at DESC`
      )
      .all(hostSessionId)
      .find((row) => !UNAVAILABLE_TMUX_STATUSES.has(row.status))

    return runtime === undefined ? undefined : { hostSessionId, runtimeId: runtime.runtimeId }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

export function readLatestAssistantMessageSeq(
  hrcDbPath: string,
  input: {
    hostSessionId: string
    sessionRef: SessionRef
  }
): number {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const row = db
      .query<{ hrcSeq: number | null }, [string, string, string]>(
        `SELECT MAX(hrc_seq) AS hrcSeq
          FROM hrc_events
          WHERE host_session_id = ?
            AND scope_ref = ?
            AND lane_ref = ?
            AND event_kind = 'turn.message'`
      )
      .get(input.hostSessionId, input.sessionRef.scopeRef, input.sessionRef.laneRef)
    return row?.hrcSeq ?? 0
  } catch {
    return 0
  } finally {
    db.close()
  }
}

async function pollAssistantMessageAfterSeq(options: {
  hrcDbPath: string
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
  timeoutMs: number
}): Promise<UnifiedSessionEvent | undefined> {
  const deadline = Date.now() + options.timeoutMs

  while (Date.now() <= deadline) {
    const message = readAssistantMessageAfterSeq(options)
    if (message !== undefined) {
      return message
    }
    await Bun.sleep(RAW_EVENT_POLL_INTERVAL_MS)
  }

  return readAssistantMessageAfterSeq(options)
}

export function readAssistantMessageAfterSeq(options: {
  hrcDbPath: string
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
}): UnifiedSessionEvent | undefined {
  const db = new Database(options.hrcDbPath, { readonly: true })
  try {
    const row = db
      .query<{ hrcSeq: number; payloadJson: string }, [string, string, string, number]>(
        `SELECT hrc_seq AS hrcSeq, payload_json AS payloadJson
          FROM hrc_events
          WHERE host_session_id = ?
            AND scope_ref = ?
            AND lane_ref = ?
            AND event_kind = 'turn.message'
            AND hrc_seq > ?
          ORDER BY hrc_seq ASC
          LIMIT 1`
      )
      .get(
        options.hostSessionId,
        options.sessionRef.scopeRef,
        options.sessionRef.laneRef,
        options.afterHrcSeq
      )
    if (!row) {
      return undefined
    }

    return assistantMessagePayloadToUnifiedEvent(parseJson(row.payloadJson))
  } finally {
    db.close()
  }
}

function assistantMessagePayloadToUnifiedEvent(payload: unknown): UnifiedSessionEvent | undefined {
  const record = asRecord(payload)
  if (readString(record, 'type') !== 'message_end') {
    return undefined
  }

  const message = asRecord(record['message'])
  if (readString(message, 'role') !== 'assistant') {
    return undefined
  }

  const text = extractAssistantText(message['content'])
  if (text === undefined || text.trim().length === 0) {
    return undefined
  }

  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

export function readCompletedAssistantMessageFromHrcEvents(
  hrcDbPath: string,
  runId: string
): UnifiedSessionEvent | undefined {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const rows = db
      .query<{ eventKind: string; payloadJson: string }, [string]>(
        `SELECT event_kind AS eventKind, payload_json AS payloadJson
          FROM hrc_events
          WHERE run_id = ?
            AND event_kind IN ('turn.message', 'turn.completed')
          ORDER BY hrc_seq ASC`
      )
      .all(runId)

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row?.eventKind !== 'turn.completed') {
        continue
      }
      const event = assistantCompletionPayloadToUnifiedEvent(parseJson(row.payloadJson))
      if (event !== undefined) {
        return event
      }
    }

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row?.eventKind !== 'turn.message') {
        continue
      }
      const event = assistantMessagePayloadToUnifiedEvent(parseJson(row.payloadJson))
      if (event !== undefined) {
        return event
      }
    }

    return undefined
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

function assistantCompletionPayloadToUnifiedEvent(
  payload: unknown
): UnifiedSessionEvent | undefined {
  const record = asRecord(payload)

  const fromMessage = assistantMessagePayloadToUnifiedEvent({
    type: 'message_end',
    message: record['message'],
  })
  if (fromMessage !== undefined) {
    return fromMessage
  }

  const finalOutput = readString(record, 'finalOutput') ?? readString(record, 'content')
  if (finalOutput === undefined || finalOutput.trim().length === 0) {
    const source = readString(record, 'source')
    const outcome = asRecord(record['outcome'])
    if (
      (readString(outcome, 'state') === 'degraded' &&
        readString(outcome, 'reason') === 'no_assistant_content') ||
      source === 'launch_exit_synthesized' ||
      source === 'codex_app_server' ||
      source === 'codex_jsonl'
    ) {
      return {
        type: 'turn_end',
        payload,
      }
    }
    return undefined
  }

  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: finalOutput }],
    },
  }
}

function inferHarnessIntent(input: {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
}): HrcHarnessIntent {
  const placement = input.intent.placement
  const agentRoot = placement.agentRoot
  const fromProfile = readHarnessIntentFromAgentProfile(agentRoot)
  if (fromProfile !== undefined) {
    return fromProfile
  }

  const fromAgentRootPath = readHarnessProviderFromPath(agentRoot)
  if (fromAgentRootPath !== undefined) {
    return {
      provider: fromAgentRootPath,
      interactive: true,
    }
  }

  const parsedScope = parseScopeRef(input.sessionRef.scopeRef)
  const fromProjectModules = readHarnessProviderFromProjectModules({
    projectRoot: placement.projectRoot,
    agentId: parsedScope.agentId,
  })
  if (fromProjectModules !== undefined) {
    return {
      provider: fromProjectModules,
      interactive: true,
    }
  }

  return {
    provider: 'anthropic',
    interactive: true,
  }
}

function readHarnessIntentFromAgentProfile(agentRoot: string): HrcHarnessIntent | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return undefined
  }

  try {
    const profile = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
    const entry = resolveHarnessCatalogEntry(profile.identity?.harness)
    if (entry === undefined) {
      return undefined
    }
    return {
      provider: entry.provider,
      interactive: entry.transport !== 'sdk',
      ...(entry.frontend !== undefined ? { id: entry.frontend } : {}),
    }
  } catch {
    return undefined
  }
}

function readHarnessProviderFromProjectModules(input: {
  projectRoot?: string | undefined
  agentId: string
}): 'anthropic' | 'openai' | undefined {
  if (input.projectRoot === undefined) {
    return undefined
  }

  const codexPath = join(input.projectRoot, 'asp_modules', input.agentId, 'codex')
  if (existsSync(codexPath)) {
    return 'openai'
  }

  const claudePath = join(input.projectRoot, 'asp_modules', input.agentId, 'claude')
  if (existsSync(claudePath)) {
    return 'anthropic'
  }

  return undefined
}

function readHarnessProviderFromPath(path: string): 'anthropic' | 'openai' | undefined {
  if (path.includes('/claude')) {
    return 'anthropic'
  }
  if (path.includes('/codex')) {
    return 'openai'
  }
  return undefined
}

function readAssistantMessageEndEvent(
  eventJson: Record<string, unknown>
): UnifiedSessionEvent | undefined {
  const message = asRecord(eventJson['message'])
  if (readString(message, 'role') !== 'assistant') {
    return undefined
  }

  const text = extractAssistantText(message['content'])
  if (text === undefined || text.trim().length === 0) {
    return undefined
  }

  const messageId = readString(eventJson, 'messageId')

  return {
    type: 'message_end',
    ...(messageId !== undefined ? { messageId } : {}),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

function readAssistantMessageId(eventJson: Record<string, unknown>): string | undefined {
  const payload = asRecord(eventJson['payload'])
  const message = asRecord(payload['message'])
  return readString(message, 'id')
}

function extractAssistantText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const textParts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (readString(record, 'type') !== 'text') {
      continue
    }
    const text = readString(record, 'text')
    if (text !== undefined) {
      textParts.push(text)
    }
  }

  return textParts.length > 0 ? textParts.join('') : undefined
}

function toHrcSessionRef(sessionRef: SessionRef): string {
  return `${sessionRef.scopeRef}/lane:${sessionRef.laneRef}`
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
