import { basename } from 'node:path'

import type { Actor } from 'acp-core'
import { formatHrcExternalRef, isHrcExternalRef, parseHrcExternalRef } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import { parseScopeRef } from 'agent-scope'

import type { LaunchCommandScopedRun, LaunchRoleScopedRun } from '../deps.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import type { WrkfLaunchInfo, WrkfParticipantLaunchDeps } from './participant-launch.js'
import { isRecord, readOptionalString, readRecord } from './value.js'

/**
 * Action-level launch/bind adapter (Node D, contract C-0004).
 *
 * ACP is an ADAPTER ONLY. `launchAction` composes:
 *   1. `wrkf.action.start`   — open (or idempotently replay) ONE semantic
 *      action run on the task (wrkf is the action-truth ledger).
 *   2. HRC launch via `launchRoleScopedRun` — start the runtime that does the
 *      action.
 *   3. `wrkf.action.bindExternal` — bind the canonical `hrc:<id>` ref onto the
 *      action run (wrkf is the binding-truth ledger).
 *
 * The adapter keeps ONLY operational retry/correlation state in the ACP run
 * store (launch claim, discovered HRC ref, orphan markers). It MUST NOT persist
 * semantic action truth or task scalar run truth — it never writes `cp_*`,
 * `session_id`, `sdk_session_id`, or `run_status` as action truth.
 *
 * Idempotency / reconciliation across the non-atomic gap (the frozen predicate):
 *   - Retry after `action.start`: wrkf is idempotent on `idempotencyKey`. If the
 *     returned action run ALREADY carries a non-empty `externalRunRef` it is a
 *     replay — return immediately, never launch HRC again (one wrkf action run).
 *   - Retry after HRC launch but before bind: the durable ACP run (keyed on the
 *     action run's underlying `runId`) carries `hrcRunId`; we re-bind that exact
 *     ref instead of launching a second HRC run (one canonical HRC binding). The
 *     durable launch claim blocks a concurrent/ambiguous relaunch.
 *   - Retry after bind response loss: `bindExternal` is idempotent on
 *     `${idempotencyKey}:bindExternal` and re-binds the SAME `hrc:<id>`; wrkf
 *     rejects a conflicting ref. On any bind error we mark the ACP run
 *     `wrkfExternalBind.status='orphaned'` and surface — never silently drop.
 *
 * This mirrors the run-level `launchParticipant` adapter; the only structural
 * differences are the action surface (`action.start`/`action.bindExternal`,
 * which key the bind on `actionRunId`) and the absence of a task projection.
 */

export type WrkfActionLaunchInput = {
  taskId: string
  /** Semantic action: triage | implement | review | verify | custom string. */
  action: string
  /** Optional explicit role; wrkf defaults it from the action when omitted. */
  role?: string | undefined
  actor?: Actor | undefined
  lane?: string | undefined
  idempotencyKey: string
  sessionRef: SessionRef
  initialPrompt?: string | undefined
  stdinJson?: Record<string, unknown> | undefined
}

export type WrkfActionLaunchDeps = WrkfParticipantLaunchDeps & {
  launchCommandScopedRun?: LaunchCommandScopedRun | undefined
  triageCommandTargetId?: string | undefined
  implCommandTargetId?: string | undefined
  verifyCommandTargetId?: string | undefined
  triageCommandLaunchTimeoutMs?: number | undefined
}

export type WrkfActionLaunchResult = {
  source: 'wrkf-action'
  taskId: string
  /** The semantic action run id (bind keys on this). */
  actionRunId: string
  /** The action run's underlying run id (the ACP run store is keyed on this). */
  wrkfRunId: string
  /** Bare HRC run id, when a canonical binding exists. */
  hrcRunId?: string | undefined
  /** The canonical `hrc:<id>` external ref bound on the action run. */
  externalRunRef?: string | undefined
  launch?: WrkfLaunchInfo | undefined
  replay: boolean
}

const DEFAULT_TRIAGE_COMMAND_LAUNCH_TIMEOUT_MS = 30_000

export async function launchAction(
  deps: WrkfActionLaunchDeps,
  input: WrkfActionLaunchInput
): Promise<WrkfActionLaunchResult> {
  // The action surface takes a STRING actor (`<kind>:<id>`), unlike the run
  // surface which accepts the structured Actor object. Stringify here.
  const actorString = formatActionActor(input.actor)
  const actionRun = asRecord(
    await deps.wrkf.action.start({
      task: input.taskId,
      action: input.action,
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(actorString !== undefined ? { actor: actorString } : {}),
      ...(input.lane !== undefined ? { lane: input.lane } : {}),
      idempotencyKey: input.idempotencyKey,
    }),
    'wrkf.action.start result'
  )

  const actionRunId = readRequiredString(actionRun, 'actionRunId', 'wrkf.action.start result')
  // The ACP run store is keyed on the action run's UNDERLYING run id, not the
  // semantic actionRunId — createOrGetRun derives `run_wrkf_<runId>`.
  const wrkfRunId = readRequiredString(actionRun, 'runId', 'wrkf.action.start result')
  const instanceId = readOptionalString(actionRun, 'instanceId') ?? input.taskId
  const workflowRef = readActionWorkflowRef(actionRun) ?? 'unknown'
  const role = readOptionalString(actionRun, 'role') ?? input.role ?? 'unknown'

  // Replay: the action run already carries a bound external ref → one wrkf action
  // run already exists with its canonical HRC binding. Never launch HRC again.
  const existingRef = readOptionalString(actionRun, 'externalRunRef')
  if (existingRef !== undefined) {
    return buildResult({
      taskId: input.taskId,
      actionRunId,
      wrkfRunId,
      externalRunRef: existingRef,
      ...(isHrcExternalRef(existingRef) ? { hrcRunId: parseHrcExternalRef(existingRef) } : {}),
      replay: true,
    })
  }

  const { run: acpRun, created } = deps.runStore.createOrGetRun({
    sessionRef: input.sessionRef,
    wrkfTaskId: input.taskId,
    wrkfInstanceId: instanceId,
    wrkfRunId,
    workflowRef,
    role,
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  })

  const existingBind = readRecord(acpRun.metadata?.['wrkfExternalBind'])
  if (existingBind?.['status'] === 'orphaned') {
    throw launchBlockedError(acpRun, 'wrkf action launch has an orphaned HRC bind')
  }

  // Crash-window recovery: a prior attempt launched HRC (hrcRunId committed) but
  // crashed before bind completed. Re-bind the discovered ref — do not relaunch.
  if (!created && acpRun.hrcRunId !== undefined) {
    await bindExternalOrMarkOrphan(deps, input, {
      acpRunId: acpRun.runId,
      actionRunId,
      wrkfRunId,
      hrcRunId: acpRun.hrcRunId,
      deliveryRef: {
        kind: 'hrc',
        runId: acpRun.hrcRunId,
        hostSessionId: acpRun.hostSessionId,
        runtimeId: acpRun.runtimeId,
        scopeRef: input.sessionRef.scopeRef,
        laneRef: input.sessionRef.laneRef,
        generation: acpRun.generation,
      },
      currentMetadata: acpRun.metadata,
    })
    return buildResult({
      taskId: input.taskId,
      actionRunId,
      wrkfRunId,
      hrcRunId: acpRun.hrcRunId,
      externalRunRef: formatHrcExternalRef(acpRun.hrcRunId),
      replay: false,
    })
  }

  const claim = deps.runStore.acquireLaunchClaim({
    runId: acpRun.runId,
    claimId: `${input.idempotencyKey}:launch`,
    idempotencyKey: input.idempotencyKey,
    wrkfRunId,
  })
  if (!claim.acquired) {
    throw launchBlockedError(claim.run, 'wrkf action launch already has a durable launch claim')
  }

  const commandTargetId = commandTargetIdForAction(deps, input.action)
  if (commandTargetId !== undefined) {
    return await launchConfiguredCommandRun(deps, input, {
      actionRun,
      actionRunId,
      wrkfRunId,
      role,
      acpRunId: acpRun.runId,
      claimMetadata: claim.run.metadata,
      configuredTargetId: commandTargetId,
    })
  }

  const prompt = buildActionPrompt({ input, actionRun, actionRunId, wrkfRunId, role, workflowRef })

  // Launch phase: intent resolution + HRC launch. Both run AFTER wrkf.action.start
  // has opened the action run, and either can throw (e.g. the live repro: an
  // unlaunchable worker scope with no runtime placement made resolveLaunchIntent
  // throw). Any failure here leaves an active action run with no externalRunRef, so
  // the adapter MUST terminalize it (wrkf.action.fail) before surfacing the original
  // error — never strand an unbound active action (T-05039, daedalus DM #9631). The
  // rollback is the primary path; the reconciler/orphan janitor is only a backstop.
  let launched: Awaited<ReturnType<LaunchRoleScopedRun>>
  try {
    const intent = await resolveLaunchIntent(
      deps as Parameters<typeof resolveLaunchIntent>[0],
      input.sessionRef,
      { initialPrompt: prompt }
    )
    launched = await deps.launchRoleScopedRun({
      sessionRef: input.sessionRef,
      intent,
      acpRunId: acpRun.runId,
      runStore: deps.runStore,
      waitForCompletion: false,
    })
  } catch (error) {
    deps.runStore.updateRun(acpRun.runId, {
      status: 'failed',
      errorCode: 'wrkf_launch_failed_ambiguous',
      errorMessage: error instanceof Error ? error.message : String(error),
      metadata: mergeMetadata(claim.run.metadata, {
        wrkfLaunchClaim: {
          ...readRecord(claim.run.metadata?.['wrkfLaunchClaim']),
          status: 'launch_failed',
          wrkfRunId,
          errorCode: 'wrkf_launch_failed_ambiguous',
          errorMessage: error instanceof Error ? error.message : String(error),
          failedAt: new Date().toISOString(),
        },
      }),
    })
    await failActionRollback(deps, input, { actionRunId, wrkfRunId, error, phase: 'launch' })
    throw error
  }
  const launchInfo = toLaunchInfo(launched)

  // Record the HRC runId BEFORE bind so crash-window recovery can re-bind it.
  const launchedRun = deps.runStore.updateRun(acpRun.runId, {
    hrcRunId: launched.runId,
    ...(launched.hostSessionId !== undefined ? { hostSessionId: launched.hostSessionId } : {}),
    ...(launched.runtimeId !== undefined ? { runtimeId: launched.runtimeId } : {}),
    ...(launched.generation !== undefined ? { generation: launched.generation } : {}),
    transport: 'hrc',
    metadata: mergeMetadata(claim.run.metadata, {
      wrkfLaunchClaim: {
        ...readRecord(claim.run.metadata?.['wrkfLaunchClaim']),
        status: 'launched',
        hrcRunId: launched.runId,
        launchedAt: new Date().toISOString(),
      },
    }),
  })

  await bindExternalOrMarkOrphan(deps, input, {
    acpRunId: acpRun.runId,
    actionRunId,
    wrkfRunId,
    hrcRunId: launched.runId,
    deliveryRef: {
      kind: 'hrc',
      runId: launched.runId,
      hostSessionId: launched.hostSessionId,
      runtimeId: launched.runtimeId,
      launchId: launched.launchId,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      generation: launched.generation,
    },
    currentMetadata: launchedRun.metadata,
  })

  return buildResult({
    taskId: input.taskId,
    actionRunId,
    wrkfRunId,
    hrcRunId: launched.runId,
    externalRunRef: formatHrcExternalRef(launched.runId),
    launch: launchInfo,
    replay: false,
  })
}

async function launchConfiguredCommandRun(
  deps: WrkfActionLaunchDeps,
  input: WrkfActionLaunchInput,
  args: {
    actionRun: Record<string, unknown>
    actionRunId: string
    wrkfRunId: string
    role: string
    acpRunId: string
    claimMetadata?: Readonly<Record<string, unknown>> | undefined
    configuredTargetId: string
  }
): Promise<WrkfActionLaunchResult> {
  const launchCommandScopedRun = deps.launchCommandScopedRun
  const configuredTargetId = args.configuredTargetId
  if (launchCommandScopedRun === undefined) {
    const error = new Error(`configured ${input.action} command-run launcher is unavailable`)
    deps.runStore.updateRun(args.acpRunId, {
      status: 'failed',
      errorCode: 'wrkf_launch_failed_ambiguous',
      errorMessage: error.message,
      metadata: mergeMetadata(args.claimMetadata, {
        wrkfLaunchClaim: {
          ...readRecord(args.claimMetadata?.['wrkfLaunchClaim']),
          status: 'launch_failed',
          wrkfRunId: args.wrkfRunId,
          errorCode: 'wrkf_launch_failed_ambiguous',
          errorMessage: error.message,
          failedAt: new Date().toISOString(),
        },
      }),
    })
    await failActionRollback(deps, input, {
      actionRunId: args.actionRunId,
      wrkfRunId: args.wrkfRunId,
      error,
      phase: 'launch',
    })
    throw error
  }

  let launched: Awaited<ReturnType<LaunchCommandScopedRun>>
  try {
    const projectSlug = readProjectSlug(deps, input.sessionRef)
    const launchPromise = Promise.resolve(
      launchCommandScopedRun({
        configuredTargetId,
        sessionRef: input.sessionRef,
        idempotencyKey: `${input.idempotencyKey}:launchCommand`,
        binding: buildTriageCommandBinding(input, args, projectSlug),
        stdinJson: {
          ...(input.stdinJson ?? {}),
          taskId: input.taskId,
          actionRunId: args.actionRunId,
          wrkfRunId: args.wrkfRunId,
          action: input.action,
          role: args.role,
          project: projectSlug,
          sessionRef: input.sessionRef.scopeRef,
          lane: input.sessionRef.laneRef,
          actionRun: args.actionRun,
        },
      })
    )
    recordLateCommandLaunchOrphan(deps, input, args, launchPromise)
    launched = await withTimeout(
      launchPromise,
      resolveTriageCommandLaunchTimeoutMs(deps),
      'timed out waiting for HRC command-run launch correlation'
    )
  } catch (error) {
    deps.runStore.updateRun(args.acpRunId, {
      status: 'failed',
      errorCode: 'wrkf_launch_failed_ambiguous',
      errorMessage: error instanceof Error ? error.message : String(error),
      metadata: mergeMetadata(args.claimMetadata, {
        wrkfLaunchClaim: {
          ...readRecord(args.claimMetadata?.['wrkfLaunchClaim']),
          status: 'launch_failed',
          wrkfRunId: args.wrkfRunId,
          errorCode: 'wrkf_launch_failed_ambiguous',
          errorMessage: error instanceof Error ? error.message : String(error),
          failedAt: new Date().toISOString(),
        },
      }),
    })
    await failActionRollback(deps, input, {
      actionRunId: args.actionRunId,
      wrkfRunId: args.wrkfRunId,
      error,
      phase: 'launch',
    })
    throw error
  }

  const launchInfo = toLaunchInfo(launched)
  const launchedRun = deps.runStore.updateRun(args.acpRunId, {
    hrcRunId: launched.runId,
    hostSessionId: launched.hostSessionId,
    runtimeId: launched.runtimeId,
    generation: launched.generation,
    transport: launched.transport,
    metadata: mergeMetadata(args.claimMetadata, {
      wrkfLaunchClaim: {
        ...readRecord(args.claimMetadata?.['wrkfLaunchClaim']),
        status: 'launched',
        hrcRunId: launched.runId,
        launchedAt: new Date().toISOString(),
      },
    }),
  })

  await bindExternalOrMarkOrphan(deps, input, {
    acpRunId: args.acpRunId,
    actionRunId: args.actionRunId,
    wrkfRunId: args.wrkfRunId,
    hrcRunId: launched.runId,
    deliveryRef: {
      kind: 'hrc',
      runId: launched.runId,
      hostSessionId: launched.hostSessionId,
      runtimeId: launched.runtimeId,
      launchId: launched.launchId,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      generation: launched.generation,
      transport: launched.transport,
    },
    currentMetadata: launchedRun.metadata,
  })

  return buildResult({
    taskId: input.taskId,
    actionRunId: args.actionRunId,
    wrkfRunId: args.wrkfRunId,
    hrcRunId: launched.runId,
    externalRunRef: formatHrcExternalRef(launched.runId),
    launch: launchInfo,
    replay: false,
  })
}

/**
 * Terminalize the action run after a launch-phase failure (T-05039). Calls
 * `wrkf.action.fail` once with a deterministic idempotency key (keyed on the
 * caller idempotencyKey so retries dedup) and run-linked failure evidence. This
 * is best-effort: any error from the fail call itself is swallowed so the ORIGINAL
 * launch error always surfaces to the caller; a residual active action is then
 * covered by the reconciler/orphan-janitor backstop. ACP only ever records
 * FAILURE here — semantic success authority belongs to the launched worker.
 */
async function failActionRollback(
  deps: WrkfActionLaunchDeps,
  input: WrkfActionLaunchInput,
  args: {
    actionRunId: string
    wrkfRunId: string
    hrcRunId?: string | undefined
    error: unknown
    /**
     * `launch`: intent resolution / HRC launch failed before any binding.
     * `bind`: the HRC run exists but the canonical bind failed — terminalize with
     * the hrcRunId so the orphaned runtime is correlatable.
     */
    phase: 'launch' | 'bind'
  }
): Promise<void> {
  const errorMessage = args.error instanceof Error ? args.error.message : String(args.error)
  const summary =
    args.phase === 'bind'
      ? 'ACP failed to bind the worker runtime to the action (orphaned launch)'
      : 'ACP launch failed before binding the worker runtime'
  try {
    await deps.wrkf.action.fail({
      actionRunId: args.actionRunId,
      summary,
      failureResult: {
        wrkfRunId: args.wrkfRunId,
        ...(args.hrcRunId !== undefined ? { hrcRunId: formatHrcExternalRef(args.hrcRunId) } : {}),
        phase: args.phase,
        errorMessage,
        failedBy: 'acp-adapter-rollback',
      },
      idempotencyKey: `${input.idempotencyKey}:${args.phase}Rollback`,
    })
  } catch {
    // Best-effort terminalization — never mask the original launch failure.
  }
}

function recordLateCommandLaunchOrphan(
  deps: WrkfActionLaunchDeps,
  input: WrkfActionLaunchInput,
  args: {
    actionRunId: string
    wrkfRunId: string
    acpRunId: string
    claimMetadata?: Readonly<Record<string, unknown>> | undefined
  },
  launchPromise: Promise<Awaited<ReturnType<LaunchCommandScopedRun>>>
): void {
  void launchPromise.then(
    (launched) => {
      const current = deps.runStore.getRun(args.acpRunId)
      const launchClaim = readRecord(current?.metadata?.['wrkfLaunchClaim'])
      if (launchClaim?.['status'] !== 'launch_failed') {
        return
      }

      deps.runStore.updateRun(args.acpRunId, {
        hrcRunId: launched.runId,
        hostSessionId: launched.hostSessionId,
        runtimeId: launched.runtimeId,
        generation: launched.generation,
        transport: launched.transport,
        metadata: mergeMetadata(current?.metadata ?? args.claimMetadata, {
          wrkfExternalBind: {
            status: 'orphaned',
            hrcRunId: launched.runId,
            wrkfRunId: args.wrkfRunId,
            actionRunId: args.actionRunId,
            hostSessionId: launched.hostSessionId,
            runtimeId: launched.runtimeId,
            generation: launched.generation,
            transport: launched.transport,
            scopeRef: input.sessionRef.scopeRef,
            laneRef: input.sessionRef.laneRef,
            orphanedAt: new Date().toISOString(),
            reason: 'late_command_launch_correlation_after_timeout',
          },
        }),
      })
    },
    () => {}
  )
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${message} within ${formatTimeoutDuration(timeoutMs)}`)
          error.name = 'WrkfLaunchTimeoutError'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function resolveTriageCommandLaunchTimeoutMs(deps: WrkfActionLaunchDeps): number {
  const configured = deps.triageCommandLaunchTimeoutMs
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TRIAGE_COMMAND_LAUNCH_TIMEOUT_MS
}

function commandTargetIdForAction(deps: WrkfActionLaunchDeps, action: string): string | undefined {
  if (action === 'triage') {
    return deps.triageCommandTargetId
  }
  if (action === 'implement') {
    return deps.implCommandTargetId
  }
  if (action === 'verify') {
    return deps.verifyCommandTargetId
  }
  return undefined
}

function formatTimeoutDuration(timeoutMs: number): string {
  return timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`
}

async function bindExternalOrMarkOrphan(
  deps: WrkfActionLaunchDeps,
  input: WrkfActionLaunchInput,
  args: {
    acpRunId: string
    actionRunId: string
    wrkfRunId: string
    hrcRunId: string
    deliveryRef: Readonly<Record<string, unknown>>
    currentMetadata?: Readonly<Record<string, unknown>> | undefined
  }
): Promise<void> {
  try {
    await deps.wrkf.action.bindExternal({
      actionRunId: args.actionRunId,
      externalRunRef: formatHrcExternalRef(args.hrcRunId),
      deliveryRef: stableJson(args.deliveryRef),
      idempotencyKey: `${input.idempotencyKey}:bindExternal`,
    })
  } catch (error) {
    const errorCode = readErrorCode(error) ?? 'wrkf_bind_external_failed'
    const errorMessage = error instanceof Error ? error.message : String(error)
    deps.runStore.updateRun(args.acpRunId, {
      errorCode: 'wrkf_bind_external_failed',
      errorMessage,
      metadata: mergeMetadata(args.currentMetadata, {
        wrkfExternalBind: {
          status: 'orphaned',
          hrcRunId: args.hrcRunId,
          wrkfRunId: args.wrkfRunId,
          actionRunId: args.actionRunId,
          errorCode,
          errorMessage,
          orphanedAt: new Date().toISOString(),
        },
      }),
    })
    // T-05039: the HRC run was created but never canonically bound — terminalize the
    // action so no active/unbound run is left behind (daedalus DM #9631). Carry the
    // hrcRunId as orphan evidence. Best-effort + idempotent; the ACP orphan marker
    // above still blocks a relaunch, and the reconciler/janitor remains a backstop.
    await failActionRollback(deps, input, {
      actionRunId: args.actionRunId,
      wrkfRunId: args.wrkfRunId,
      hrcRunId: args.hrcRunId,
      error,
      phase: 'bind',
    })
    throw error
  }
}

function launchBlockedError(
  run: { errorCode?: string | undefined; errorMessage?: string | undefined },
  fallbackMessage: string
): Error & { code: string } {
  const error = new Error(run.errorMessage ?? fallbackMessage) as Error & { code: string }
  error.name = 'WrkfActionLaunchBlockedError'
  error.code = 'WRKF_ACTION_LAUNCH_BLOCKED'
  return error
}

function buildResult(args: {
  taskId: string
  actionRunId: string
  wrkfRunId: string
  hrcRunId?: string | undefined
  externalRunRef?: string | undefined
  launch?: WrkfLaunchInfo | undefined
  replay: boolean
}): WrkfActionLaunchResult {
  return {
    source: 'wrkf-action',
    taskId: args.taskId,
    actionRunId: args.actionRunId,
    wrkfRunId: args.wrkfRunId,
    ...(args.hrcRunId !== undefined ? { hrcRunId: args.hrcRunId } : {}),
    ...(args.externalRunRef !== undefined ? { externalRunRef: args.externalRunRef } : {}),
    ...(args.launch !== undefined ? { launch: args.launch } : {}),
    replay: args.replay,
  }
}

function buildTriageCommandBinding(
  input: WrkfActionLaunchInput,
  args: { actionRunId: string; wrkfRunId: string; role: string },
  projectSlug: string
) {
  return {
    WRKF_TASK_ID: input.taskId,
    WRKF_ACTION_RUN_ID: args.actionRunId,
    WRKF_RUN_ID: args.wrkfRunId,
    WRKF_ACTION: input.action,
    WRKF_ROLE: args.role,
    ASP_PROJECT: projectSlug,
    HRC_SESSION_REF: input.sessionRef.scopeRef,
    HRC_LANE: input.sessionRef.laneRef,
  }
}

function readProjectSlug(deps: WrkfActionLaunchDeps, sessionRef: SessionRef): string {
  const projectId = parseScopeRef(sessionRef.scopeRef).projectId
  if (projectId === undefined || projectId.length === 0) {
    throw new Error('triage command-run launch requires sessionRef.scopeRef to include project')
  }
  const project = deps.adminStore?.projects.get(projectId)
  const projectRoot = project?.homeDir ?? project?.rootDir
  if (typeof projectRoot === 'string' && projectRoot.trim().length > 0) {
    const projectSlug = basename(projectRoot.trim())
    if (projectSlug.length > 0) {
      return projectSlug
    }
  }
  return projectId
}

/**
 * The wrkf action surface expects a string actor (`<kind>:<id>`), matching the
 * acceptance form (`agent:action-tester`). The run surface accepts a structured
 * Actor object, but `action.start` rejects an object with "invalid params".
 */
function formatActionActor(actor: Actor | undefined): string | undefined {
  if (actor === undefined) {
    return undefined
  }
  return `${actor.kind}:${actor.id}`
}

function readActionWorkflowRef(actionRun: Record<string, unknown>): string | undefined {
  const workflow = readRecord(actionRun['workflow'])
  if (workflow !== undefined) {
    const id = readOptionalString(workflow, 'id')
    if (id !== undefined) {
      const version = readOptionalString(workflow, 'version')
      return version !== undefined ? `${id}@${version}` : id
    }
  }
  return readOptionalString(actionRun, 'workflowRef')
}

/**
 * Compose the launched HRC prompt as an action-protocol envelope (daedalus
 * High-risk fix, T-05034). The envelope is ALWAYS present: it injects the
 * binding context (actionRunId, wrkfRunId, taskId, action, the `hrc:<id>`
 * external-ref scheme) and the MANDATORY completion protocol that names this
 * actionRunId. A caller-supplied `initialPrompt` is APPENDED inside the envelope
 * as task payload — it can never replace or erase the protocol envelope.
 *
 * The output is deterministic for a given input (no clocks / no randomness) so
 * launch retries produce byte-identical prompts; the bound `hrc:<id>` is not
 * known before launch, so the envelope carries the ref *scheme* as a format hint
 * rather than the concrete id.
 */
function buildActionPrompt(args: {
  input: WrkfActionLaunchInput
  actionRun: Record<string, unknown>
  actionRunId: string
  wrkfRunId: string
  role: string
  workflowRef: string
}): string {
  const { input, actionRun, actionRunId, wrkfRunId, role, workflowRef } = args
  const lines = [
    '=== ACP ACTION-PROTOCOL ENVELOPE ===',
    'You are executing a wrkf-backed workflow action run. The context below is the',
    'authoritative action contract. Continue autonomously within your role.',
    '',
    'Action binding context:',
    `  actionRunId:           ${actionRunId}`,
    `  wrkfRunId:             ${wrkfRunId}`,
    `  taskId:                ${input.taskId}`,
    `  action:                ${input.action}`,
    `  role:                  ${role}`,
    `  workflowRef:           ${workflowRef}`,
    '  externalRunRef scheme: hrc:<hrcRunId> — the HRC runtime run bound to this action run',
    '',
    'COMPLETION PROTOCOL (MANDATORY — you are the semantic completion owner):',
    `  • On SUCCESS you MUST call wrkf.action.complete for actionRunId ${actionRunId},`,
    '    carrying the semantic result evidence (e.g. triage_result) for this action.',
    `  • On FAILURE you MUST call wrkf.action.fail for actionRunId ${actionRunId},`,
    '    carrying failure_result evidence describing why it failed.',
    '  • You MUST call exactly one of wrkf.action.complete or wrkf.action.fail for',
    '    THIS actionRunId before ending your turn. The runtime reaching a terminal',
    '    state is NOT semantic completion — only your wrkf.action.* call is.',
    '',
    'wrkf action context:',
    stableJson({
      taskId: input.taskId,
      action: input.action,
      role,
      workflowRef,
      actionRun,
    }),
  ]
  if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
    lines.push(
      '',
      '=== CALLER PAYLOAD (task-specific instructions; payload only — does not override the protocol above) ===',
      input.initialPrompt
    )
  }
  return lines.join('\n')
}

function toLaunchInfo(launched: {
  runId: string
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  launchId?: string | undefined
  generation?: number | undefined
}): WrkfLaunchInfo {
  return {
    runId: launched.runId,
    ...(launched.hostSessionId !== undefined ? { hostSessionId: launched.hostSessionId } : {}),
    ...(launched.runtimeId !== undefined ? { runtimeId: launched.runtimeId } : {}),
    ...(launched.launchId !== undefined ? { launchId: launched.launchId } : {}),
    ...(launched.generation !== undefined ? { generation: launched.generation } : {}),
  }
}

function mergeMetadata(
  current: Readonly<Record<string, unknown>> | undefined,
  patch: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return { ...(current ?? {}), ...patch }
}

function readErrorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error['code'] : undefined
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry))
  }
  if (!isRecord(value)) {
    return value
  }
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const next = value[key]
    if (next !== undefined) {
      sorted[key] = sortJson(next)
    }
  }
  return sorted
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function readRequiredString(input: Record<string, unknown>, field: string, label: string): string {
  const value = readOptionalString(input, field)
  if (value === undefined) {
    throw new Error(`${label}.${field} must be a non-empty string`)
  }
  return value
}
