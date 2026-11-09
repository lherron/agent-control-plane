import { HrcConflictError, resolveDatabasePath } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import type { InputAttemptStore, LaunchRoleScopedRun, RunStore } from './deps.js'
import type { DispatchFence, UpdateRunInput } from './domain/run-store.js'
import type { JobFirstBirthAuthority } from './jobs/first-birth-authority.js'
import { readLatestAssistantMessageSeq } from './launcher-assistant-evidence.js'
import {
  RAW_EVENT_POLL_GRACE_MS,
  createHrcRunTerminalError,
  mapHrcRunTerminalStatus,
  pollCompletedAssistantMessage,
  waitForRunCompletion,
  waitForTmuxAssistantMessage,
} from './launcher-completion.js'
import {
  readVerifiedJobRunId,
  resolveFirstTurnTimeoutOverrideMs,
  resolveHrcDispatchOrigin,
  withAcpLaunchContextEnv,
  withFirstTurnTimeout,
  withHrcDispatchOrigin,
} from './launcher-context.js'
import {
  assertPromptLaunchOwnedLocally,
  findLiveTmuxRuntimeForSessionRef,
  normalizeRealLauncherIntent,
  toHrcSessionRef,
} from './launcher-placement.js'
import { findLaunchIdForRun, readRunStatus } from './launcher-run-evidence.js'
import { ACP_SERVER_USER_AGENT } from './user-agent.js'

const DEFAULT_WAIT_TIMEOUT_MS = 180_000

/**
 * The HRC client surface the launcher drives. locateScope is optional because
 * embedders may inject a partial legacy client (assertPromptLaunchOwnedLocally).
 */
export type RealLauncherClient = Pick<
  HrcClient,
  'ensureTarget' | 'resolveSession' | 'deliverLiteralBySelector' | 'dispatchTurn'
> &
  Partial<Pick<HrcClient, 'locateScope'>> &
  Pick<HrcClient, 'tailEvents' | 'watchBoundedEvents'>

type RealLauncherOptions = {
  socketPath?: string | undefined
  hrcDbPath?: string | undefined
  watchTimeoutMs?: number | undefined
  /** Legacy option; run completion now follows the HRC lifecycle stream. */
  pollIntervalMs?: number | undefined
  createClient?: ((socketPath: string) => RealLauncherClient) | undefined
  inputAttemptStore?: InputAttemptStore | undefined
  /** Without it, no launch may first-birth an unbound scope. */
  jobFirstBirthAuthority?: JobFirstBirthAuthority | undefined
}

export function createRealLauncher(options: RealLauncherOptions = {}): LaunchRoleScopedRun {
  const socketPath = options.socketPath ?? discoverSocket()
  const hrcDbPath = options.hrcDbPath ?? resolveDatabasePath()
  const createClient =
    options.createClient ??
    ((path: string) =>
      new HrcClient({
        socketPath: path,
        userAgent: ACP_SERVER_USER_AGENT,
        caller: 'acp-server:launcher',
      }))
  const inputAttemptStore = options.inputAttemptStore
  const waitTimeoutMs = options.watchTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS

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
    const launchIntent = withAcpLaunchContextEnv(intent, {
      acpRunId,
      inputAttemptId,
      runStore,
    })
    const normalizedIntent = await normalizeRealLauncherIntent({
      sessionRef,
      intent: launchIntent,
      liveTmuxRuntime: liveTmuxRuntime !== undefined,
      socketPath,
    })
    const acpCorrelationId = acpRunId ?? inputAttemptId
    const shouldWaitForCompletion = onEvent !== undefined && waitForCompletion !== false
    const prompt = normalizedIntent.initialPrompt?.trim()
    // Human prompt delivery moved to the collaboration ledger in rooms wave 4.
    // Admission returns before this launcher for those envelopes, while this
    // placement gate prevents stale callers from locally first-birthing an
    // unbound scope or launching against a remote authority. The one exception
    // is a verified ACP job run (T-09993): it births its own unbound target
    // through HRC's native ensure-target door, where HRC's summon authority
    // still decides placement, then dispatches like any bound-local launch.
    const placement = await assertPromptLaunchOwnedLocally({
      client,
      sessionRef,
      prompt,
      jobRunId: readVerifiedJobRunId({
        inputAttemptStore,
        inputAttemptId,
        acpRunId,
        runStore,
        sessionRef,
        authority: options.jobFirstBirthAuthority,
      }),
    })
    if (placement === 'job-first-birth') {
      await client.ensureTarget({
        sessionRef: toHrcSessionRef(sessionRef),
        runtimeIntent: normalizedIntent,
      })
    }

    if (!prompt) {
      // Broker cutover (T-01691): HRC retired the headless cold-start path.
      // A fresh scope has no host session, so resolveSession without create
      // returns found:false / hostSessionId:null. Passing create:true makes
      // HRC mint the host session; the runtime is provisioned by the broker on
      // the first dispatch turn (there is none here — no prompt — so this only
      // ensures continuity exists).
      const resolved = await client.resolveSession({
        sessionRef: toHrcSessionRef(sessionRef),
        runtimeIntent: normalizedIntent,
        create: true,
      })
      if (!resolved.found) {
        throw new Error(
          `HRC could not resolve or provision a session for ${toHrcSessionRef(sessionRef)}`
        )
      }
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
        generation: resolved.generation,
      }
    }

    // Broker cutover (T-01691): create:true mints the host session for a fresh
    // scope (cold-launch). dispatchTurn below then provisions the runtime via
    // the broker on this first turn — mirroring the `hrc run` CLI cold-start.
    const resolved = await client.resolveSession({
      sessionRef: toHrcSessionRef(sessionRef),
      runtimeIntent: normalizedIntent,
      create: true,
    })
    if (!resolved.found) {
      throw new Error(
        `HRC could not resolve or provision a session for ${toHrcSessionRef(sessionRef)}`
      )
    }
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
      const deliveredHrcRunId = normalizeOptionalRunId(delivered.runId)
      const deliveredRuntimeId = delivered.runtimeId ?? liveTmuxRuntime.runtimeId
      const hrcRunCorrelation = tmuxHrcRunCorrelationPatch(deliveredHrcRunId)

      updateAcpRun(runStore, acpRunId, {
        status: 'running',
        ...hrcRunCorrelation,
        hostSessionId: delivered.hostSessionId,
        generation: delivered.generation,
        runtimeId: deliveredRuntimeId,
        transport: 'tmux',
        afterHrcSeq: latestAssistantSeq,
      })

      if (shouldWaitForCompletion && onEvent !== undefined) {
        const assistantMessage = await waitForTmuxAssistantMessage({
          hrcDbPath,
          deliveredHrcRunId,
          hostSessionId: delivered.hostSessionId,
          sessionRef,
          afterHrcSeq: latestAssistantSeq,
          timeoutMs: waitTimeoutMs,
          client,
          runStore,
          acpRunId,
        })
        if (assistantMessage === undefined) {
          throw new Error(
            `HRC tmux runtime ${deliveredRuntimeId} did not produce an assistant reply event${acpCorrelationId !== undefined ? ` for ${acpCorrelationId}` : ''}`
          )
        }
        await onEvent(assistantMessage)
        updateAcpRun(runStore, acpRunId, {
          status: 'completed',
          errorCode: null,
          errorMessage: null,
        })
      }

      return buildTmuxLaunchResult({
        hrcDbPath,
        hrcRunId: deliveredHrcRunId,
        hostSessionId: delivered.hostSessionId,
        runtimeId: deliveredRuntimeId,
        generation: delivered.generation,
      })
    }

    const targetSession = resolved
    const dispatchOrigin = resolveHrcDispatchOrigin({
      inputAttemptStore,
      inputAttemptId,
      acpRunId,
      runStore,
    })
    let dispatched: Awaited<ReturnType<typeof client.dispatchTurn>>
    try {
      dispatched = await client.dispatchTurn(
        withFirstTurnTimeout(
          withHrcDispatchOrigin(
            {
              hostSessionId: targetSession.hostSessionId,
              prompt,
              ...(normalizedIntent.attachments !== undefined
                ? { attachments: normalizedIntent.attachments }
                : {}),
              fences: dispatchFence,
              runtimeIntent: normalizedIntent,
              waitForCompletion: shouldWaitForCompletion,
            },
            dispatchOrigin
          ),
          resolveFirstTurnTimeoutOverrideMs(sessionRef.scopeRef)
        )
      )
    } catch (error) {
      persistFenceDispatchError(runStore, acpRunId, error)
      throw error
    }

    const dispatchedRunId = dispatched.runId
    if (dispatchedRunId === undefined) {
      throw new Error(
        `HRC dispatch for ${dispatched.hostSessionId} returned no runId (stage ${dispatched.stage})`
      )
    }
    const dispatchedAcpStatus = dispatched.status === 'completed' ? 'completed' : 'running'
    updateAcpRun(runStore, acpRunId, {
      hrcRunId: dispatchedRunId,
      status: dispatchedAcpStatus,
      hostSessionId: dispatched.hostSessionId,
      generation: dispatched.generation,
      runtimeId: dispatched.runtimeId,
      transport: dispatched.transport,
      ...(dispatchedAcpStatus === 'completed' ? { errorCode: null, errorMessage: null } : {}),
    })

    if (shouldWaitForCompletion) {
      const completedRun =
        dispatched.status === 'completed'
          ? (readRunStatus(hrcDbPath, dispatchedRunId) ?? {
              status: 'completed',
            })
          : await waitForRunCompletion({
              hrcDbPath,
              runId: dispatchedRunId,
              timeoutMs: waitTimeoutMs,
              client,
            })

      const terminalOutcome = mapHrcRunTerminalStatus(completedRun)
      if (terminalOutcome === undefined) {
        throw new Error(
          `HRC run ${dispatchedRunId} returned non-terminal status ${completedRun.status} after completion`
        )
      }
      updateAcpRun(runStore, acpRunId, {
        hrcRunId: dispatchedRunId,
        status: terminalOutcome.status,
        errorCode: terminalOutcome.status === 'completed' ? null : completedRun.errorCode,
        errorMessage: terminalOutcome.status === 'completed' ? null : completedRun.errorMessage,
      })

      if (completedRun.status !== 'completed') {
        throw createHrcRunTerminalError(dispatchedRunId, completedRun)
      }
    }

    if (shouldWaitForCompletion && onEvent !== undefined) {
      const completedAssistantMessage = await pollCompletedAssistantMessage({
        hrcDbPath,
        runId: dispatchedRunId,
        timeoutMs: RAW_EVENT_POLL_GRACE_MS,
      })
      if (completedAssistantMessage === undefined) {
        throw new Error(
          `HRC run ${dispatchedRunId} completed without an assistant reply event${acpCorrelationId !== undefined ? ` for ${acpCorrelationId}` : ''}`
        )
      }
      await onEvent(completedAssistantMessage)
    }

    return {
      runId: dispatchedRunId,
      sessionId: targetSession.hostSessionId,
      hostSessionId: dispatched.hostSessionId,
      runtimeId: dispatched.runtimeId,
      launchId: findLaunchIdForRun(hrcDbPath, dispatchedRunId),
      generation: dispatched.generation,
    }
  }
}

function normalizeOptionalRunId(runId: string | undefined): string | undefined {
  const normalized = runId?.trim()
  return normalized ? normalized : undefined
}

function tmuxHrcRunCorrelationPatch(
  hrcRunId: string | undefined
): Pick<UpdateRunInput, 'hrcRunId'> {
  return hrcRunId === undefined ? {} : { hrcRunId }
}

function buildTmuxLaunchResult(input: {
  hrcDbPath: string
  hrcRunId: string | undefined
  hostSessionId: string
  runtimeId: string
  generation: number
}): {
  runId: string
  sessionId: string
  hostSessionId: string
  runtimeId: string
  launchId: string | undefined
  generation: number
} {
  return {
    runId: input.hrcRunId ?? input.hostSessionId,
    sessionId: input.hostSessionId,
    hostSessionId: input.hostSessionId,
    runtimeId: input.runtimeId,
    launchId:
      input.hrcRunId === undefined
        ? undefined
        : findLaunchIdForRun(input.hrcDbPath, input.hrcRunId),
    generation: input.generation,
  }
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
