import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type SessionRef, parseScopeRef } from 'agent-scope'
import {
  HrcConflictError,
  type HrcEventEnvelope,
  type HrcRuntimeIntent,
  resolveDatabasePath,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { parseAgentProfile, resolveHarnessProvider } from 'spaces-config'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import type { LaunchRoleScopedRun, RunStore } from './deps.js'
import type { DispatchFence, UpdateRunInput } from './domain/run-store.js'

const DEFAULT_WAIT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 500
const RAW_EVENT_POLL_INTERVAL_MS = 100
const RAW_EVENT_POLL_GRACE_MS = 2_000
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const UNAVAILABLE_TMUX_STATUSES = new Set(['terminated', 'stale', 'failed', 'exited'])

type RawRunEventRecord = Pick<HrcEventEnvelope, 'eventKind' | 'eventJson'>

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

  return async ({ sessionRef, intent, acpRunId, inputAttemptId, runStore, onEvent }) => {
    const client = createClient(socketPath)
    const liveTmuxRuntime = findLiveTmuxRuntimeForSessionRef(hrcDbPath, sessionRef)
    const normalizedIntent = normalizeRealLauncherIntent({
      sessionRef,
      intent,
      liveTmuxRuntime: liveTmuxRuntime !== undefined,
    })
    const acpCorrelationId = acpRunId ?? inputAttemptId
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
        status: onEvent !== undefined ? 'running' : 'completed',
        hostSessionId: delivered.hostSessionId,
        generation: delivered.generation,
        runtimeId: delivered.runtimeId ?? liveTmuxRuntime.runtimeId,
        transport: 'tmux',
      })

      if (onEvent !== undefined) {
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

    const shouldWaitForCompletion =
      onEvent !== undefined || (runStore !== undefined && acpRunId !== undefined)
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

    if (onEvent !== undefined) {
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
    }
  }
}

export function normalizeRealLauncherIntent(input: {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
  liveTmuxRuntime?: boolean | undefined
}): HrcRuntimeIntent {
  const provider = input.intent.harness?.provider ?? inferHarnessProvider(input)
  const preferredMode = input.liveTmuxRuntime
    ? ('interactive' as const)
    : (input.intent.execution?.preferredMode ?? ('headless' as const))
  const normalizedExecution = {
    ...input.intent.execution,
    preferredMode,
  }
  const harness =
    input.intent.harness ??
    ({
      provider,
      interactive: true,
    } satisfies HrcRuntimeIntent['harness'])
  const normalizedHarness =
    preferredMode === 'interactive' ? { ...harness, interactive: true } : harness

  return {
    ...input.intent,
    placement: {
      ...input.intent.placement,
      ...(input.intent.placement.dryRun === undefined ? { dryRun: false } : {}),
    },
    harness: normalizedHarness,
    execution: normalizedExecution,
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
    const message = toUnifiedAssistantMessageEndFromRawEvents(
      listRawRunEvents(options.hrcDbPath, options.runId)
    )
    if (message !== undefined) {
      return message
    }
    await Bun.sleep(RAW_EVENT_POLL_INTERVAL_MS)
  }

  return toUnifiedAssistantMessageEndFromRawEvents(
    listRawRunEvents(options.hrcDbPath, options.runId)
  )
}

function readRunStatus(
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

function listRawRunEvents(hrcDbPath: string, runId: string): RawRunEventRecord[] {
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

function readLatestAssistantMessageSeq(
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

function readAssistantMessageAfterSeq(options: {
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

function inferHarnessProvider(input: {
  sessionRef: SessionRef
  intent: HrcRuntimeIntent
}): 'anthropic' | 'openai' {
  const placement = input.intent.placement
  const agentRoot = placement.agentRoot
  const fromProfile = readHarnessProviderFromAgentProfile(agentRoot)
  if (fromProfile !== undefined) {
    return fromProfile
  }

  const fromAgentRootPath = readHarnessProviderFromPath(agentRoot)
  if (fromAgentRootPath !== undefined) {
    return fromAgentRootPath
  }

  const parsedScope = parseScopeRef(input.sessionRef.scopeRef)
  const fromProjectModules = readHarnessProviderFromProjectModules({
    projectRoot: placement.projectRoot,
    agentId: parsedScope.agentId,
  })
  if (fromProjectModules !== undefined) {
    return fromProjectModules
  }

  return 'anthropic'
}

function readHarnessProviderFromAgentProfile(
  agentRoot: string
): 'anthropic' | 'openai' | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return undefined
  }

  try {
    const profile = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
    const provider = resolveHarnessProvider(profile.identity?.harness)
    return provider === 'anthropic' || provider === 'openai' ? provider : undefined
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
