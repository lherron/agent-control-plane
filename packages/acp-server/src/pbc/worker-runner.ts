import type { Actor } from 'acp-core'
import type { PbcContinuationJob } from 'acp-state-store'
import { normalizeSessionRef } from 'agent-scope'
import type { WrkqStoreAdapter } from 'wrkq-lib'
import type { ResolvedAcpServerDeps } from '../deps.js'
import { resolveHrcRoutes } from '../hrc-client.js'
import {
  readOptionalFiniteNumber as readNumber,
  readObjectRecord as readRecord,
  readOptionalNonEmptyString as readString,
} from '../internal/read-helpers.js'
import { getRunFinalAssistantText } from '../jobs/run-final-output.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import { readRunStatus } from '../launcher-run-evidence.js'
import type { AcpServerCliOptions } from '../server-config.js'
import { type PbcContinuationWorkerPort, runPbcContinuationWorker } from './worker.js'

// PBC continuation worker launches participant turns as real provisioned agents.
// Draft (agent role) and pressure reviewer must be DISTINCT for separation-of-duty.
// Overridable per deployment; a task's explicit roleMap still takes precedence.
const PBC_DRAFT_AGENT = process.env['ACP_PBC_DRAFT_AGENT']?.trim() || 'pbc-writer'
const PBC_REVIEWER_AGENT = process.env['ACP_PBC_REVIEWER_AGENT']?.trim() || 'pbc-reviewer'

export function createPbcWorkerRunner(input: {
  deps: ResolvedAcpServerDeps
  wrkqStore: WrkqStoreAdapter | undefined
  options: AcpServerCliOptions
}): ((job: PbcContinuationJob) => Promise<void>) | undefined {
  const wrkf = input.deps.wrkf
  const stateStore = input.deps.stateStore
  const wrkqStore = input.wrkqStore
  if (
    wrkf === undefined ||
    input.deps.launchRoleScopedRun === undefined ||
    stateStore === undefined ||
    wrkqStore === undefined
  ) {
    return undefined
  }

  return async (job) => {
    let latestWrkfRunId: string | undefined
    const port: PbcContinuationWorkerPort = {
      next: (params) => wrkf.next(params),
      evidence: {
        list: async (params) => {
          const listed = await wrkf.evidence.list(params)
          return Array.isArray(listed) ? listed : []
        },
        add: (params) => wrkf.evidence.add(params as never),
      },
      obligation: {
        list: async (params) => {
          const listed = await wrkf.obligation.list(params)
          return Array.isArray(listed) ? listed : []
        },
        satisfy: (params) => wrkf.obligation.satisfy(params),
      },
      captures: input.deps.pbcCaptureStore,
      run: {
        start: async (params) => {
          const run = await wrkf.run.start(params as never)
          latestWrkfRunId = recordId(run)
          return run
        },
        finish: (params) => wrkf.run.finish(params),
        fail: (params) => wrkf.run.fail(params),
        bindExternal: (params) => wrkf.run.bindExternal(params),
      },
      transition: {
        apply: (params) => wrkf.transition.apply(params as never),
      },
      effect: wrkf.effect,
      launchAcpRun: async (params) => {
        if (latestWrkfRunId === undefined || latestWrkfRunId.length === 0) {
          throw new Error(`wrkf run id unavailable for PBC job ${job.jobId}`)
        }
        return launchPbcWorkerAcpRun({
          deps: input.deps,
          wrkqStore,
          options: input.options,
          job,
          wrkfRunId: latestWrkfRunId,
          taskId: params.taskId,
          role: params.role,
          actor: params.actor,
          idempotencyKey: params.idempotencyKey,
          prompt: params.prompt,
        })
      },
      getFinalAssistantText: (acpRunId) =>
        getRunFinalAssistantText(
          {
            getRun: (runId) => input.deps.runStore.getRun(runId),
            hrc: resolveHrcRoutes(input.deps, 'acp-server:pbc'),
          },
          acpRunId
        ),
      getRunStatus: async (acpRunId) => {
        const acpRun = input.deps.runStore.getRun(acpRunId)
        if (acpRun?.hrcRunId === undefined) {
          return undefined
        }
        return (
          await readRunStatus(resolveHrcRoutes(input.deps, 'acp-server:pbc'), acpRun.hrcRunId)
        )?.status
      },
      jobs: {
        renewLease: (params) => stateStore.pbcContinuationJobs.renewLease(params),
        transition: (params) => stateStore.pbcContinuationJobs.transition(params),
      },
    }

    const [pbcActor, pbcPressureActor] = await Promise.all([
      pbcActorWireForRole(wrkqStore, job.taskId, 'agent', PBC_DRAFT_AGENT),
      pbcActorWireForRole(wrkqStore, job.taskId, 'pressure_reviewer', PBC_REVIEWER_AGENT),
    ])
    await runPbcContinuationWorker(port, {
      taskId: job.taskId,
      idempotencyKey: job.idempotencyKey,
      actor: pbcActor,
      pressureActor: pbcPressureActor,
      jobId: job.jobId,
      ...(job.leaseOwner !== undefined ? { leaseOwner: job.leaseOwner } : {}),
    })
  }
}

async function launchPbcWorkerAcpRun(input: {
  deps: ResolvedAcpServerDeps
  wrkqStore: WrkqStoreAdapter
  options: AcpServerCliOptions
  job: PbcContinuationJob
  wrkfRunId: string
  taskId: string
  role: string
  actor: string
  idempotencyKey: string
  prompt?: string | undefined
}): Promise<{ acpRunId: string }> {
  if (input.deps.wrkf === undefined || input.deps.launchRoleScopedRun === undefined) {
    throw new Error('PBC continuation worker requires wrkf and launchRoleScopedRun')
  }

  const projection = await readPbcWorkerProjection(input.deps, input.job)
  const actor =
    actorFromWire(input.actor) ??
    ({
      kind: 'agent',
      id: await agentIdForRole(input.wrkqStore, input.options, input.taskId, input.role),
    } as Actor)
  const sessionRef = normalizeSessionRef({
    scopeRef: await scopeRefForWorkerRole(
      input.wrkqStore,
      input.options,
      input.taskId,
      input.role,
      actor
    ),
    laneRef: 'main',
  })
  const { run: acpRun, created } = input.deps.runStore.createOrGetRun({
    sessionRef,
    wrkfTaskId: input.taskId,
    wrkfInstanceId: projection.instanceId,
    wrkfRunId: input.wrkfRunId,
    workflowRef: projection.workflowRef,
    role: input.role,
    actor,
  })

  const existingExternalBind = readRecord(acpRun.metadata?.['wrkfExternalBind'])
  if (existingExternalBind?.['status'] === 'orphaned') {
    throw new Error('PBC continuation worker launch has an orphaned HRC bind')
  }
  if (!created && acpRun.hrcRunId !== undefined) {
    return { acpRunId: acpRun.runId }
  }

  const claim = input.deps.runStore.acquireLaunchClaim({
    runId: acpRun.runId,
    claimId: `${input.idempotencyKey}:claim`,
    idempotencyKey: input.idempotencyKey,
    wrkfRunId: input.wrkfRunId,
  })
  if (!claim.acquired) {
    throw new Error('PBC continuation worker launch claim was not acquired')
  }

  // Inject the participant's actor/role + task so the agent's direct `wrkf`
  // calls (next -> evidence add) default to the right identity WITHOUT passing
  // --actor/--role. wrkf reads WRKF_ACTOR/WRKF_ROLE as defaults (actorDefault/
  // roleDefault). NOTE: this is NOT an authority boundary — wrkq T-03777 trimmed
  // E2 (trusted binding) out, and these are overridable. The real anti-fabrication
  // gate stays in ACP's evidence policy on the human /input path.
  const intent = await resolveLaunchIntent(input.deps, sessionRef, {
    ...(input.prompt !== undefined ? { initialPrompt: input.prompt } : {}),
    env: {
      WRKF_ACTOR: actor.id,
      WRKF_ROLE: input.role,
      WRKF_TASK: input.taskId,
    },
  })
  let launched: Awaited<ReturnType<NonNullable<ResolvedAcpServerDeps['launchRoleScopedRun']>>>
  try {
    launched = await input.deps.launchRoleScopedRun({
      sessionRef,
      intent,
      acpRunId: acpRun.runId,
      runStore: input.deps.runStore,
      waitForCompletion: true,
    })
  } catch (error) {
    input.deps.runStore.updateRun(acpRun.runId, {
      errorCode: 'pbc_worker_launch_failed',
      errorMessage: error instanceof Error ? error.message : String(error),
      metadata: {
        ...claim.run.metadata,
        wrkfLaunchClaim: {
          ...readRecord(claim.run.metadata?.['wrkfLaunchClaim']),
          status: 'launch_failed',
          wrkfRunId: input.wrkfRunId,
          failedAt: new Date().toISOString(),
        },
      },
    })
    throw error
  }

  input.deps.runStore.updateRun(acpRun.runId, {
    hrcRunId: launched.runId,
    ...(launched.hostSessionId !== undefined ? { hostSessionId: launched.hostSessionId } : {}),
    ...(launched.runtimeId !== undefined ? { runtimeId: launched.runtimeId } : {}),
    ...(launched.generation !== undefined ? { generation: launched.generation } : {}),
    transport: 'hrc',
    metadata: {
      ...claim.run.metadata,
      wrkfLaunchClaim: {
        ...readRecord(claim.run.metadata?.['wrkfLaunchClaim']),
        status: 'launched',
        hrcRunId: launched.runId,
        launchedAt: new Date().toISOString(),
      },
    },
  })

  return { acpRunId: acpRun.runId }
}

async function readPbcWorkerProjection(
  deps: ResolvedAcpServerDeps,
  job: PbcContinuationJob
): Promise<{ instanceId: string; workflowRef: string; revision: number }> {
  const inspected = deps.wrkf?.task.inspect({ task: job.taskId }).catch(() => undefined)
  const next = deps.wrkf?.next({ task: job.taskId }).catch(() => undefined)
  const inspectedRecord = readRecord(inspected === undefined ? undefined : await inspected)
  const nextRecord = readRecord(next === undefined ? undefined : await next)
  const instance =
    readRecord(inspectedRecord?.['instance']) ?? readRecord(nextRecord?.['instance']) ?? {}
  const parsedRevision = Number(job.revisionAtAdmission)

  return {
    instanceId:
      readString(instance, 'id') ??
      readString(instance, 'instanceId') ??
      readString(inspectedRecord, 'id') ??
      job.taskId,
    workflowRef:
      readString(instance, 'workflowRef') ??
      readString(instance, 'workflowId') ??
      readString(inspectedRecord, 'templateId') ??
      job.workflowRef,
    revision:
      readNumber(instance, 'revision') ?? (Number.isFinite(parsedRevision) ? parsedRevision : 0),
  }
}

async function agentIdForRole(
  wrkqStore: WrkqStoreAdapter,
  options: AcpServerCliOptions,
  taskId: string,
  role: string
): Promise<string> {
  const task = await wrkqStore.taskStore.getTask(taskId)
  const roleMap = (await wrkqStore.roleAssignmentStore.getRoleMap(taskId)) ?? task?.roleMap ?? {}
  return roleMap[role]?.trim() || roleMap['agent']?.trim() || options.actor
}

// PBC worker participant resolution: a task's explicit roleMap wins; otherwise
// fall back to the configured PBC default agent (NOT the server identity), so the
// launched runtime resolves a real provisioned agent profile.
async function pbcActorWireForRole(
  wrkqStore: WrkqStoreAdapter,
  taskId: string,
  role: string,
  fallbackAgentId: string
): Promise<string> {
  const task = await wrkqStore.taskStore.getTask(taskId)
  const roleMap = (await wrkqStore.roleAssignmentStore.getRoleMap(taskId)) ?? task?.roleMap ?? {}
  const id = roleMap[role]?.trim() || fallbackAgentId
  return `agent:${id}`
}

async function scopeRefForWorkerRole(
  wrkqStore: WrkqStoreAdapter,
  options: AcpServerCliOptions,
  taskId: string,
  role: string,
  actor: Actor
): Promise<string> {
  const task = await wrkqStore.taskStore.getTask(taskId)
  const agentId =
    actor.kind === 'agent' ? actor.id : await agentIdForRole(wrkqStore, options, taskId, role)
  const projectSegment = task?.projectId !== undefined ? `:project:${task.projectId}` : ''
  return `agent:${agentId}${projectSegment}:task:${taskId}:role:${role}`
}

function actorFromWire(input: string): Actor | undefined {
  const separator = input.indexOf(':')
  if (separator <= 0 || separator === input.length - 1) {
    return undefined
  }
  const kind = input.slice(0, separator)
  const id = input.slice(separator + 1)
  if (kind === 'agent' || kind === 'human' || kind === 'system') {
    return { kind, id } as Actor
  }
  return undefined
}

function recordId(record: unknown): string {
  const id = readRecord(record)?.['id']
  return typeof id === 'string' ? id : ''
}
