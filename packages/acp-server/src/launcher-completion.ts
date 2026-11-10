import type { SessionRef } from 'agent-scope'
import type { HrcClient } from 'hrc-sdk'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import type { RunStore } from './deps.js'
import type { HrcRouteReader } from './hrc-route-reader.js'
import {
  readAssistantMessageAfterSeq,
  readCompletedAssistantMessageFromHrcEvents,
} from './launcher-assistant-evidence.js'
import { readRunStatus } from './launcher-run-evidence.js'

export const RAW_EVENT_POLL_GRACE_MS = 2_000
const RAW_EVENT_POLL_INTERVAL_MS = 100
const RUN_TERMINAL_EVENT_KINDS = new Set([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.reaped',
  'runtime.terminated',
])

export async function waitForTmuxAssistantMessage(options: {
  hrc: HrcRouteReader
  deliveredHrcRunId: string | undefined
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
  timeoutMs: number
  client: Pick<HrcClient, 'tailEvents' | 'watchBoundedEvents'>
  runStore: RunStore | undefined
  acpRunId: string | undefined
}): Promise<UnifiedSessionEvent | undefined> {
  if (options.deliveredHrcRunId === undefined) {
    // Compatibility fallback for older HRC servers that do not return the
    // broker-created run ID from literal Enter dispatch.
    return pollAssistantMessageAfterSeq({
      hrc: options.hrc,
      hostSessionId: options.hostSessionId,
      sessionRef: options.sessionRef,
      afterHrcSeq: options.afterHrcSeq,
      timeoutMs: options.timeoutMs,
    })
  }

  const completedRun = await waitForRunCompletion({
    hrc: options.hrc,
    runId: options.deliveredHrcRunId,
    timeoutMs: options.timeoutMs,
    client: options.client,
  })
  const terminalOutcome = mapHrcRunTerminalStatus(completedRun)
  if (terminalOutcome === undefined) {
    throw new Error(
      `HRC run ${options.deliveredHrcRunId} returned non-terminal status ${completedRun.status} after completion`
    )
  }
  if (options.runStore !== undefined && options.acpRunId !== undefined)
    options.runStore.updateRun(options.acpRunId, {
      status: terminalOutcome.status,
      errorCode: terminalOutcome.status === 'completed' ? null : completedRun.errorCode,
      errorMessage: terminalOutcome.status === 'completed' ? null : completedRun.errorMessage,
    })
  if (terminalOutcome.status !== 'completed') {
    throw createHrcRunTerminalError(options.deliveredHrcRunId, completedRun)
  }
  return pollCompletedAssistantMessage({
    hrc: options.hrc,
    runId: options.deliveredHrcRunId,
    timeoutMs: RAW_EVENT_POLL_GRACE_MS,
  })
}

export async function waitForRunCompletion(options: {
  hrc: HrcRouteReader
  runId: string
  timeoutMs: number
  client: Pick<HrcClient, 'tailEvents' | 'watchBoundedEvents'>
}): Promise<{
  status: string
  errorCode?: string | undefined
  errorMessage?: string | undefined
}> {
  const deadline = Date.now() + options.timeoutMs
  const timeoutError = () => new Error(`timed out waiting for HRC run ${options.runId} to complete`)
  let backoffMs = 250
  while (Date.now() < deadline) {
    // Bootstrap/reconnect is authoritative. Never settle from event payloads.
    // A failed read is not terminal; the stream below and the backoff retry it.
    const run = await readRunStatus(options.hrc, options.runId).catch(() => undefined)
    if (run !== undefined && mapHrcRunTerminalStatus(run) !== undefined) return run
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Bound the whole attempt, including tailEvents (which has no signal).
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          abort.abort()
          reject(timeoutError())
        },
        Math.min(30_000, deadline - Date.now())
      )
    })
    try {
      const terminal = await Promise.race([
        (async () => {
          const tail = await options.client.tailEvents({ runId: options.runId, limit: 1 })
          if (abort.signal.aborted) return undefined
          for await (const record of options.client.watchBoundedEvents({
            ledgerIncarnationId: tail.ledgerIncarnationId,
            afterSeq: tail.headHrcSeq,
            runId: options.runId,
            signal: abort.signal,
          })) {
            if (abort.signal.aborted) return undefined
            if (
              record.type === 'gap' ||
              record.type === 'ledger_replaced' ||
              record.type === 'home_unreachable'
            )
              break
            // ready closes the tail/status/subscribe race, including terminal
            // state committed before the captured head. Filter run IDs too.
            if (
              record.type !== 'ready' &&
              (record.event.runId !== options.runId ||
                !RUN_TERMINAL_EVENT_KINDS.has(record.event.eventKind))
            )
              continue
            const current = await readRunStatus(options.hrc, options.runId)
            if (current !== undefined && mapHrcRunTerminalStatus(current) !== undefined)
              return current
            if (record.type !== 'ready') backoffMs = 250
          }
          return undefined
        })(),
        bound,
      ])
      if (terminal !== undefined) return terminal
    } catch {
      if (Date.now() >= deadline) throw timeoutError()
      // Reopen after transport failure, gap, ledger replacement or the 30 s
      // missed-event repair bound. Bootstrap and ready check authoritative state.
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
    // The stream may close normally, or repeatedly refuse. Avoid a hot loop.
    await Bun.sleep(Math.max(0, Math.min(backoffMs, deadline - Date.now())))
    backoffMs = Math.min(backoffMs * 2, 5_000)
  }
  throw timeoutError()
}

export function mapHrcRunTerminalStatus(run: {
  status: string
  errorCode?: string | undefined
  errorMessage?: string | undefined
}): { status: 'completed' | 'failed' | 'cancelled' } | undefined {
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return { status: run.status }
  }

  // HRC currently exposes no user/operator termination discriminator on its run
  // row. A bare termination therefore uses ACP's conservative failure outcome;
  // do not infer cancellation from free-form error details.
  if (run.status === 'terminated') {
    return { status: 'failed' }
  }

  return undefined
}

export function createHrcRunTerminalError(
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

export async function pollCompletedAssistantMessage(options: {
  hrc: HrcRouteReader
  runId: string
  timeoutMs: number
}): Promise<UnifiedSessionEvent | undefined> {
  const deadline = Date.now() + options.timeoutMs

  while (Date.now() <= deadline) {
    const message = await readCompletedAssistantMessageFromHrcEvents(options.hrc, options.runId)
    if (message !== undefined) {
      return message
    }
    await Bun.sleep(RAW_EVENT_POLL_INTERVAL_MS)
  }

  return readCompletedAssistantMessageFromHrcEvents(options.hrc, options.runId)
}

async function pollAssistantMessageAfterSeq(options: {
  hrc: HrcRouteReader
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
  timeoutMs: number
}): Promise<UnifiedSessionEvent | undefined> {
  const deadline = Date.now() + options.timeoutMs

  while (Date.now() <= deadline) {
    const message = await readAssistantMessageAfterSeq(options)
    if (message !== undefined) {
      return message
    }
    await Bun.sleep(RAW_EVENT_POLL_INTERVAL_MS)
  }

  return readAssistantMessageAfterSeq(options)
}
