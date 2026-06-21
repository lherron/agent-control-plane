import type { Actor } from 'acp-core'
import { formatHrcExternalRef, isHrcExternalRef, parseHrcExternalRef } from 'acp-core'
import type { SessionRef } from 'agent-scope'

import type { LaunchRoleScopedRun } from '../deps.js'
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
}

/** Deps mirror the run-level participant-launch adapter exactly. */
export type WrkfActionLaunchDeps = WrkfParticipantLaunchDeps

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

  const prompt = input.initialPrompt ?? buildActionPrompt({ input, actionRun, role, workflowRef })
  const intent = await resolveLaunchIntent(
    deps as Parameters<typeof resolveLaunchIntent>[0],
    input.sessionRef,
    { initialPrompt: prompt }
  )

  let launched: Awaited<ReturnType<LaunchRoleScopedRun>>
  try {
    launched = await deps.launchRoleScopedRun({
      sessionRef: input.sessionRef,
      intent,
      acpRunId: acpRun.runId,
      runStore: deps.runStore,
      waitForCompletion: false,
    })
  } catch (error) {
    deps.runStore.updateRun(acpRun.runId, {
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

function buildActionPrompt(args: {
  input: WrkfActionLaunchInput
  actionRun: Record<string, unknown>
  role: string
  workflowRef: string
}): string {
  return [
    'You are starting an ACP workflow action run.',
    'Use the wrkf action context below as the authoritative task contract and continue autonomously within your role.',
    '',
    stableJson({
      taskId: args.input.taskId,
      action: args.input.action,
      role: args.role,
      workflowRef: args.workflowRef,
      actionRun: args.actionRun,
    }),
  ].join('\n')
}

function toLaunchInfo(launched: Awaited<ReturnType<LaunchRoleScopedRun>>): WrkfLaunchInfo {
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
