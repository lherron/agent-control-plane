#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { openSqliteAdminStore } from 'acp-admin-store'
import { startAcpCapabilityHost } from 'acp-capability-host'
import { openSqliteConversationStore } from 'acp-conversation'
import type { Actor } from 'acp-core'
import { openInterfaceStore } from 'acp-interface-store'
import { createJobsScheduler, openSqliteJobsStore } from 'acp-jobs-store'
import { type PbcContinuationJob, openAcpStateStore } from 'acp-state-store'
import { type SessionRef, normalizeSessionRef, parseScopeRef } from 'agent-scope'
import { openCoordinationStore } from 'coordination-substrate'
import { resolveControlSocketPath, resolveDatabasePath } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { buildRuntimeBundleRef, getAgentsRoot, resolveAgentPlacementPaths } from 'spaces-config'
import type { WrkqStoreAdapter } from 'wrkq-lib'

import { createAccessLogger } from './access-log.js'
import { createAcpServer } from './create-acp-server.js'
import {
  type AcpHrcClient,
  type AcpRuntimePlacement,
  DEFAULT_AGENT_ASSETS_DIR,
  DEFAULT_INTERFACE_DB_PATH,
  DEFAULT_STATE_DB_PATH,
  type ResolvedAcpServerDeps,
  resolveAcpServerDeps,
} from './deps.js'
import { createDevFlowLauncher } from './dev-flow-launcher.js'
import { createEchoLauncher } from './echo-launcher.js'
import { dispatchJobRunThroughInputs } from './handlers/admin-jobs.js'
import { buildMobileUpgradeData, parseMobileRouteKind } from './handlers/mobile-ws.js'
import {
  closeMobileWebSocket,
  handleMobileWebSocketMessage,
  openMobileWebSocket,
} from './handlers/mobile.js'
import { InputAdmissionService } from './input-admission/input-admission-service.js'
import { createInputQueueDispatcher } from './integration/input-queue-dispatcher.js'
import { createInterfaceRunDispatcher } from './integration/interface-run-dispatcher.js'
import { createWakeDispatcher } from './integration/wake-dispatcher.js'
import {
  readOptionalFiniteNumber as readNumber,
  readObjectRecord as readRecord,
  readOptionalNonEmptyString as readString,
} from './internal/read-helpers.js'
import { createEventJobEvaluator } from './jobs/event-job-evaluator.js'
import { advanceJobFlow } from './jobs/flow-engine.js'
import { ensureDispatchTimeoutHealthJob } from './jobs/health-dispatch-timeout.js'
import { createJobLifecycleEmitter } from './jobs/lifecycle-events.js'
import { createJobOutputReconciler } from './jobs/output-reconciler.js'
import { getRunFinalAssistantText } from './jobs/run-final-output.js'
import { resolveLaunchIntent } from './launch-role-scoped.js'
import { createPbcWorkerScheduler } from './pbc/worker-scheduler.js'
import { type PbcContinuationWorkerPort, runPbcContinuationWorker } from './pbc/worker.js'
import { createRealLauncher, readRunStatus } from './real-launcher.js'
import { createWrkfClientLifecycle } from './wrkf/client-lifecycle.js'

const DEFAULT_COORD_DB_PATH = '/Users/lherron/praesidium/var/db/acp-coordination.db'
const DEFAULT_PORT = 18470
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_ACTOR = 'acp-server'
const DEFAULT_ACP_RUNTIME_DIR = '/Users/lherron/praesidium/var/run/acp'
const DEFAULT_CAP_CATALOG_STATE_DIR = '/Users/lherron/praesidium/var/state/acp-server/cap-catalog'
// PBC continuation worker launches participant turns as real provisioned agents.
// Draft (agent role) and pressure reviewer must be DISTINCT for separation-of-duty.
// Overridable per deployment; a task's explicit roleMap still takes precedence.
const PBC_DRAFT_AGENT = process.env['ACP_PBC_DRAFT_AGENT']?.trim() || 'pbc-writer'
const PBC_REVIEWER_AGENT = process.env['ACP_PBC_REVIEWER_AGENT']?.trim() || 'pbc-reviewer'
const DEFAULT_JOBS_SCHEDULER_INTERVAL_MS = 5_000
const DEFAULT_INTERFACE_DISPATCHER_INTERVAL_MS = 2_000
const DEFAULT_INTERFACE_DISPATCHER_STALE_TIMEOUT_MS = 600_000 // 10 minutes
const DEFAULT_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS = 45_000
const DEFAULT_INPUT_QUEUE_DISPATCHER_INTERVAL_MS = 2_000
const DEFAULT_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS = 45_000
const DEFAULT_INPUT_QUEUE_LEASE_TIMEOUT_MS = 600_000
const ACP_SERVER_VERSION = '0.1.0'
const TRIAGE_COMMAND_TARGET_ID_ENV = 'ACP_TRIAGE_COMMAND_TARGET_ID'

export function isEnabledEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw.length === 0) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export interface ResolveLauncherDepsOptions {
  createHrcClient?: ((socketPath: string) => AcpHrcClient) | undefined
}

export interface AcpServerCliOptions {
  wrkqDbPath: string
  coordDbPath: string
  interfaceDbPath: string
  stateDbPath: string
  adminDbPath?: string | undefined
  jobsDbPath?: string | undefined
  conversationDbPath?: string | undefined
  agentAssetsDir: string
  host: string
  port: number
  actor: string
}

type ParsedCliArgs = {
  help: boolean
  options: Partial<AcpServerCliOptions>
}

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const options: Partial<AcpServerCliOptions> = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return { help: true, options }
    }

    const nextValue = args[index + 1]
    const requireValue = (flag: string): string => {
      if (nextValue === undefined || nextValue.startsWith('-')) {
        throw new Error(`${flag} requires a value`)
      }

      index += 1
      return nextValue
    }

    switch (arg) {
      case '--wrkq-db-path':
        options.wrkqDbPath = requireValue(arg)
        break
      case '--coord-db-path':
        options.coordDbPath = requireValue(arg)
        break
      case '--host':
        options.host = requireValue(arg)
        break
      case '--admin-db-path':
        options.adminDbPath = requireValue(arg)
        break
      case '--jobs-db-path':
        options.jobsDbPath = requireValue(arg)
        break
      case '--conversation-db-path':
        options.conversationDbPath = requireValue(arg)
        break
      case '--interface-db-path':
        options.interfaceDbPath = requireValue(arg)
        break
      case '--state-db-path':
        options.stateDbPath = requireValue(arg)
        break
      case '--agent-assets-dir':
        options.agentAssetsDir = requireValue(arg)
        break
      case '--port': {
        const port = Number.parseInt(requireValue(arg), 10)
        if (!Number.isFinite(port) || port <= 0) {
          throw new Error('--port must be a positive integer')
        }
        options.port = port
        break
      }
      case '--actor':
        options.actor = requireValue(arg)
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  return { help: false, options }
}

export function resolveCliOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): { help: boolean; options: AcpServerCliOptions } {
  const parsed = parseCliArgs(args)
  const wrkqDbPath = parsed.options.wrkqDbPath ?? env['ACP_WRKQ_DB_PATH'] ?? env['WRKQ_DB_PATH']
  if (!parsed.help && (wrkqDbPath === undefined || wrkqDbPath.trim().length === 0)) {
    throw new Error('ACP_WRKQ_DB_PATH or WRKQ_DB_PATH is required')
  }

  const envPort = Number.parseInt(env['ACP_PORT'] ?? '', 10)
  const interfaceDbPath =
    parsed.options.interfaceDbPath ?? env['ACP_INTERFACE_DB_PATH'] ?? DEFAULT_INTERFACE_DB_PATH
  const adminDbPath = resolveOptionalSiblingDbPath(
    parsed.options.adminDbPath ?? env['ACP_ADMIN_DB_PATH'],
    interfaceDbPath,
    'acp-admin.db'
  )
  const jobsDbPath = resolveOptionalSiblingDbPath(
    parsed.options.jobsDbPath ?? env['ACP_JOBS_DB_PATH'],
    interfaceDbPath,
    'acp-jobs.db'
  )
  const conversationDbPath = resolveOptionalSiblingDbPath(
    parsed.options.conversationDbPath ?? env['ACP_CONVERSATION_DB_PATH'],
    interfaceDbPath,
    'acp-conversation.db'
  )

  const agentAssetsDir =
    parsed.options.agentAssetsDir ?? env['ACP_AGENT_ASSETS_DIR'] ?? DEFAULT_AGENT_ASSETS_DIR

  return {
    help: parsed.help,
    options: {
      wrkqDbPath: wrkqDbPath?.trim() ?? '',
      coordDbPath: parsed.options.coordDbPath ?? env['ACP_COORD_DB_PATH'] ?? DEFAULT_COORD_DB_PATH,
      interfaceDbPath,
      stateDbPath: parsed.options.stateDbPath ?? env['ACP_STATE_DB_PATH'] ?? DEFAULT_STATE_DB_PATH,
      ...(adminDbPath !== undefined ? { adminDbPath } : {}),
      ...(jobsDbPath !== undefined ? { jobsDbPath } : {}),
      ...(conversationDbPath !== undefined ? { conversationDbPath } : {}),
      agentAssetsDir,
      host: parsed.options.host ?? env['ACP_HOST'] ?? DEFAULT_HOST,
      port: parsed.options.port ?? (Number.isFinite(envPort) ? envPort : DEFAULT_PORT),
      actor: parsed.options.actor ?? env['ACP_ACTOR'] ?? env['WRKQ_ACTOR'] ?? DEFAULT_ACTOR,
    },
  }
}

export function formatStartupLine(options: AcpServerCliOptions): string {
  const optionalDbSegments = [
    options.adminDbPath !== undefined ? `admin.db = ${options.adminDbPath}` : undefined,
    options.jobsDbPath !== undefined ? `jobs.db = ${options.jobsDbPath}` : undefined,
    options.conversationDbPath !== undefined
      ? `conversation.db = ${options.conversationDbPath}`
      : undefined,
  ].filter((segment) => segment !== undefined)

  return [
    `acp-server listening on http://${options.host}:${options.port}`,
    `wrkq.db = ${options.wrkqDbPath}`,
    `coord.db = ${options.coordDbPath}`,
    `interface.db = ${options.interfaceDbPath}`,
    `state.db = ${options.stateDbPath}`,
    ...optionalDbSegments,
    `agentAssets = ${options.agentAssetsDir}`,
  ].join(' ')
}

export function renderHelp(): string {
  return [
    'acp-server — Bun.serve wrapper around packages/acp-server',
    '',
    'Usage:',
    '  acp-server [--wrkq-db-path <path>] [--coord-db-path <path>] [--interface-db-path <path>] [--state-db-path <path>] [--admin-db-path <path>] [--jobs-db-path <path>] [--conversation-db-path <path>] [--agent-assets-dir <path>] [--host <host>] [--port <port>] [--actor <agentId>]',
    '',
    'Environment:',
    '  ACP_WRKQ_DB_PATH  Defaults to WRKQ_DB_PATH',
    `  ACP_COORD_DB_PATH Defaults to ${DEFAULT_COORD_DB_PATH}`,
    `  ACP_INTERFACE_DB_PATH Defaults to ${DEFAULT_INTERFACE_DB_PATH}`,
    `  ACP_STATE_DB_PATH Defaults to ${DEFAULT_STATE_DB_PATH}`,
    '  ACP_ADMIN_DB_PATH Opens optional admin store when set; blank uses sibling acp-admin.db',
    '  ACP_JOBS_DB_PATH Opens optional jobs store when set; blank uses sibling acp-jobs.db',
    '  ACP_SCHEDULER_ENABLED Set to 1 or true to enable the in-process jobs scheduler',
    '  ACP_CONVERSATION_DB_PATH Opens optional conversation store when set; blank uses sibling acp-conversation.db',
    `  ACP_AGENT_ASSETS_DIR Defaults to ${DEFAULT_AGENT_ASSETS_DIR}`,
    `  ACP_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS Defaults to ${DEFAULT_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS}`,
    `  ACP_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS Defaults to ${DEFAULT_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS}`,
    `  ACP_INPUT_QUEUE_LEASE_TIMEOUT_MS Defaults to ${DEFAULT_INPUT_QUEUE_LEASE_TIMEOUT_MS}`,
    `  ACP_HOST          Defaults to ${DEFAULT_HOST}`,
    `  ACP_PORT          Defaults to ${DEFAULT_PORT}`,
    '  ACP_BASE_URL      Set at startup to the server base URL used by capability bindings',
    '  ACP_CAP_SOCKET_PATH Defaults to $ACP_RUNTIME_DIR/cap.sock',
    '  ACP_CAPABILITIES_DIR Defaults to <cwd>/capabilities',
    `  ACP_CAP_CATALOG_STATE_DIR Defaults to ${DEFAULT_CAP_CATALOG_STATE_DIR}`,
    `  ACP_ACTOR         Defaults to WRKQ_ACTOR or ${DEFAULT_ACTOR}`,
    '  WRKF_BIN          Defaults to wrkf',
    '  WRKF_DB_PATH      Defaults to the ACP wrkq DB path (wrkf shares the wrkq DB)',
    '  ACP_WRKF_DISABLED Set to 1 or true to bypass wrkf startup in local dev/test',
  ].join('\n')
}

function resolveAcpBaseUrl(options: AcpServerCliOptions): string {
  const host = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host
  return `http://${host}:${options.port}`
}

function resolveCapSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['ACP_CAP_SOCKET_PATH']?.trim()
  if (configured !== undefined && configured.length > 0) {
    return configured
  }

  const runtimeDir = env['ACP_RUNTIME_DIR']?.trim() || DEFAULT_ACP_RUNTIME_DIR
  return join(runtimeDir, 'cap.sock')
}

function resolveOptionalSiblingDbPath(
  configuredPath: string | undefined,
  siblingOfPath: string,
  fileName: string
): string | undefined {
  if (configuredPath === undefined) {
    return undefined
  }

  const trimmed = configuredPath.trim()
  if (trimmed.length > 0) {
    return trimmed
  }

  return join(dirname(siblingOfPath), fileName)
}

export function resolveRealLauncherAgentRoot(
  agentId: string,
  input: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {}
): string | undefined {
  const cwd = input.cwd ?? process.cwd()
  const env = input.env ?? process.env
  const agentsRoot = getAgentsRoot({ env })
  const canonicalAgentRoot = agentsRoot ? join(agentsRoot, agentId) : undefined

  if (canonicalAgentRoot !== undefined && existsSync(canonicalAgentRoot)) {
    return canonicalAgentRoot
  }

  const materializedClaudeRoot = join(cwd, 'asp_modules', agentId, 'claude')
  if (existsSync(materializedClaudeRoot)) {
    return materializedClaudeRoot
  }

  return canonicalAgentRoot
}

export function resolveRealLauncherPlacement(
  sessionRef: SessionRef,
  input: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {}
): AcpRuntimePlacement | undefined {
  const env = input.env ?? process.env
  const parsedScope = parseScopeRef(sessionRef.scopeRef)
  const agentRoot = resolveRealLauncherAgentRoot(parsedScope.agentId, {
    cwd: input.cwd,
    env,
  })
  if (agentRoot === undefined) {
    return undefined
  }

  const paths = resolveAgentPlacementPaths({
    agentId: parsedScope.agentId,
    ...(parsedScope.projectId !== undefined ? { projectId: parsedScope.projectId } : {}),
    agentRoot,
    env,
  })
  const projectRoot = paths.projectRoot
  const cwd = paths.cwd ?? projectRoot ?? agentRoot
  const bundle = buildRuntimeBundleRef({
    agentName: parsedScope.agentId,
    agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
  })

  return {
    agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    cwd,
    runMode: 'task',
    bundle,
  }
}

function toHrcSessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneRef}`
}

function readTriageCommandTargetId(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[TRIAGE_COMMAND_TARGET_ID_ENV]?.trim()
  return value && value.length > 0 ? value : undefined
}

export function resolveLauncherDeps(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  _options: ResolveLauncherDepsOptions = {}
): Partial<Parameters<typeof createAcpServer>[0]> {
  const useRealLauncher = env['ACP_REAL_HRC_LAUNCHER'] === '1'
  const useEchoLauncher = env['ACP_DEV_ECHO_LAUNCHER'] === '1'
  const useDevFlowLauncher = env['ACP_DEV_FLOW_LAUNCHER'] === '1'

  if (useRealLauncher) {
    if (useEchoLauncher) {
      console.warn('ACP_REAL_HRC_LAUNCHER=1 set; ignoring ACP_DEV_ECHO_LAUNCHER=1')
    }
    if (useDevFlowLauncher) {
      console.warn('ACP_REAL_HRC_LAUNCHER=1 set; ignoring ACP_DEV_FLOW_LAUNCHER=1')
    }

    const createHrcClient =
      _options.createHrcClient ??
      ((socketPath: string) => new HrcClient(socketPath) as unknown as AcpHrcClient)
    const socketPath = resolveControlSocketPath()
    const hrcClient: AcpHrcClient = createHrcClient(socketPath)
    const triageCommandTargetId = readTriageCommandTargetId(env)

    return {
      launchRoleScopedRun: createRealLauncher(),
      ...(triageCommandTargetId !== undefined
        ? {
            triageCommandTargetId,
            launchCommandScopedRun: (request) =>
              hrcClient.launchCommandScopedRun({
                ...request,
                sessionRef: toHrcSessionRef(
                  request.sessionRef.scopeRef,
                  request.sessionRef.laneRef
                ),
              }),
          }
        : {}),
      runtimeResolver: (sessionRef) => resolveRealLauncherPlacement(sessionRef, { cwd, env }),
      agentRootResolver: ({ agentId }) => resolveRealLauncherAgentRoot(agentId, { cwd, env }),
      hrcClient,
      sessionResolver: async (sessionRef) => {
        const result = await hrcClient.resolveSession({
          sessionRef: toHrcSessionRef(sessionRef.scopeRef, sessionRef.laneRef),
        })
        // Broker-cutover resolveSession returns a discriminated union; a fresh
        // (unprovisioned) scope yields found:false / hostSessionId:null. Map that
        // to undefined so the resolver's not-found contract is honored.
        return result.found ? result.hostSessionId : undefined
      },
    }
  }

  if (useDevFlowLauncher) {
    return {
      launchRoleScopedRun: createDevFlowLauncher(),
      agentRootResolver: ({ agentId }) => `/tmp/acp-dev-flow/${agentId}`,
    }
  }

  if (useEchoLauncher) {
    return {
      launchRoleScopedRun: createEchoLauncher(),
      agentRootResolver: ({ agentId }) => `/tmp/acp-dev-echo/${agentId}`,
    }
  }

  return {}
}

function createPbcWorkerRunner(input: {
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
            hrcDbPath: resolveDatabasePath(),
          },
          acpRunId
        ),
      getRunStatus: (acpRunId) => {
        const acpRun = input.deps.runStore.getRun(acpRunId)
        if (acpRun?.hrcRunId === undefined) {
          return undefined
        }
        return readRunStatus(resolveDatabasePath(), acpRun.hrcRunId)?.status
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
      metadata: mergeMetadata(claim.run.metadata, {
        wrkfLaunchClaim: {
          ...readRecord(claim.run.metadata?.['wrkfLaunchClaim']),
          status: 'launch_failed',
          wrkfRunId: input.wrkfRunId,
          failedAt: new Date().toISOString(),
        },
      }),
    })
    throw error
  }

  input.deps.runStore.updateRun(acpRun.runId, {
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

function mergeMetadata(
  current: Readonly<Record<string, unknown>> | undefined,
  patch: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return {
    ...(current ?? {}),
    ...patch,
  }
}

export async function startAcpServeBin(options: AcpServerCliOptions): Promise<{
  shutdown(): Promise<void>
  startupLine: string
}> {
  const acpBaseUrl = resolveAcpBaseUrl(options)
  process.env['ACP_BASE_URL'] = acpBaseUrl

  await mkdir(dirname(options.coordDbPath), { recursive: true })
  await mkdir(dirname(options.interfaceDbPath), { recursive: true })
  await mkdir(dirname(options.stateDbPath), { recursive: true })
  if (options.adminDbPath !== undefined) {
    await mkdir(dirname(options.adminDbPath), { recursive: true })
  }
  if (options.jobsDbPath !== undefined) {
    await mkdir(dirname(options.jobsDbPath), { recursive: true })
  }
  if (options.conversationDbPath !== undefined) {
    await mkdir(dirname(options.conversationDbPath), { recursive: true })
  }

  const coordStore = openCoordinationStore(options.coordDbPath)
  const interfaceStore = openInterfaceStore({
    dbPath: options.interfaceDbPath,
  })
  const stateStore = openAcpStateStore({ dbPath: options.stateDbPath })
  const adminStore =
    options.adminDbPath !== undefined
      ? openSqliteAdminStore({ dbPath: options.adminDbPath })
      : undefined
  const jobsStore =
    options.jobsDbPath !== undefined
      ? openSqliteJobsStore({ dbPath: options.jobsDbPath })
      : undefined
  const conversationStore =
    options.conversationDbPath !== undefined
      ? openSqliteConversationStore({ dbPath: options.conversationDbPath })
      : undefined
  const launcherDeps = resolveLauncherDeps(process.env, process.cwd())
  const wrkfLifecycle = await createWrkfClientLifecycle({
    ...(process.env['WRKF_BIN'] !== undefined ? { command: process.env['WRKF_BIN'] } : {}),
    // wrkf is the canonical workflow authority over the SAME wrkq SQLite DB ACP
    // already uses (options.wrkqDbPath). Defaulting to a separate wrkf.db would
    // point ACP at an empty, divergent workflow store — exactly the shadow state
    // the canonical-workflow refactor forbids. WRKF_DB_PATH stays as an override.
    dbPath: process.env['WRKF_DB_PATH'] ?? options.wrkqDbPath,
    clientInfo: { name: 'acp-server', version: ACP_SERVER_VERSION },
    wrkfDisabled: isEnabledEnvFlag(process.env['ACP_WRKF_DISABLED']),
  })
  // The wrkq store ports are the @wrkq/client-backed adapter the lifecycle
  // derives from its single shared WorkClient (undefined when wrkf is disabled).
  // ACP no longer opens wrkq.db directly.
  const wrkqStore = wrkfLifecycle.store
  const inputQueueMaxDepth = readPositiveIntegerEnv('ACP_INPUT_QUEUE_MAX_DEPTH')
  const inputQueueTtlMs = readPositiveIntegerEnv('ACP_INPUT_QUEUE_TTL_MS')
  const serverDeps = {
    ...(wrkqStore !== undefined ? { wrkqStore } : {}),
    coordStore,
    ...(adminStore !== undefined ? { adminStore } : {}),
    ...(jobsStore !== undefined ? { jobsStore } : {}),
    ...(conversationStore !== undefined ? { conversationStore } : {}),
    interfaceStore,
    stateStore,
    ...launcherDeps,
    ...(inputQueueMaxDepth !== undefined || inputQueueTtlMs !== undefined
      ? {
          inputQueuePolicy: {
            ...(inputQueueMaxDepth !== undefined ? { maxDepth: inputQueueMaxDepth } : {}),
            ...(inputQueueTtlMs !== undefined ? { ttlMs: inputQueueTtlMs } : {}),
          },
        }
      : {}),
    agentAssetsDir: options.agentAssetsDir,
    ...(wrkfLifecycle.client !== undefined ? { workClient: wrkfLifecycle.client } : {}),
    wrkf: wrkfLifecycle.wrkf,
  }
  const capabilityHost = await startAcpCapabilityHost({
    capabilitiesDir:
      process.env['ACP_CAPABILITIES_DIR']?.trim() || join(process.cwd(), 'capabilities'),
    socketPath: resolveCapSocketPath(process.env),
    catalogStateDir:
      process.env['ACP_CAP_CATALOG_STATE_DIR']?.trim() || DEFAULT_CAP_CATALOG_STATE_DIR,
    acpBaseUrl,
    logger: (message) => console.log(message),
  })
  const acpServer = createAcpServer(serverDeps)
  const resolvedDeps = resolveAcpServerDeps(serverDeps)
  if (jobsStore !== undefined) {
    ensureDispatchTimeoutHealthJob(jobsStore)
  }
  const accessLogger = await createAccessLogger(process.env['ACP_ACCESS_LOG_PATH'])
  const bunServer = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 255,
    async fetch(request, server) {
      const url = new URL(request.url)
      const mobileWsMatch =
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
          ? parseMobileRouteKind(url.pathname)
          : undefined
      if (mobileWsMatch !== undefined) {
        const upgraded = (
          server as never as { upgrade(request: Request, options: unknown): boolean }
        ).upgrade(request, {
          data: buildMobileUpgradeData(resolvedDeps, request.url, mobileWsMatch),
        })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
      }

      const start = performance.now()
      const response =
        url.pathname === '/v1/cap/rpc'
          ? await capabilityHost.handleHttpJsonRpc(request)
          : await acpServer.handler(request)
      if (accessLogger !== null) {
        accessLogger.log({
          request,
          response,
          durationMs: Math.round(performance.now() - start),
          clientIp: server.requestIP(request)?.address,
        })
      }
      return response
    },
    websocket: {
      open(ws) {
        void openMobileWebSocket(ws as never).catch((error) => {
          try {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'mobile_stream_failed',
                message: error instanceof Error ? error.message : String(error),
              })
            )
          } catch {
            // Socket may already be closed.
          }
        })
      },
      message(ws, message) {
        handleMobileWebSocketMessage(ws as never, message as never)
      },
      close(ws) {
        closeMobileWebSocket(ws as never)
      },
    },
  })
  const wakeDispatcher =
    resolvedDeps.launchRoleScopedRun !== undefined && resolvedDeps.runtimeResolver !== undefined
      ? createWakeDispatcher({
          coordStore,
          inputAttemptStore: resolvedDeps.inputAttemptStore,
          runStore: resolvedDeps.runStore,
          adminStore: resolvedDeps.adminStore,
          runtimeResolver: resolvedDeps.runtimeResolver,
          ...(resolvedDeps.agentRootResolver !== undefined
            ? { agentRootResolver: resolvedDeps.agentRootResolver }
            : {}),
          launchRoleScopedRun: resolvedDeps.launchRoleScopedRun,
          admitInput: async (input) => {
            const admitted = await new InputAdmissionService(resolvedDeps).admit({
              sessionRef: normalizeSessionRef(input.sessionRef),
              ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
              ...(input.idempotencyKey !== undefined
                ? { idempotencyKey: input.idempotencyKey }
                : {}),
              content: input.content,
              actor: input.actor,
              dispatch: true,
            })
            if (admitted.run === undefined) {
              throw new Error(
                `wake admission did not create a run: ${admitted.inputAttempt.inputAttemptId}`
              )
            }
            return {
              inputAttemptId: admitted.inputAttempt.inputAttemptId,
              runId: admitted.run.runId,
              created: admitted.created,
            }
          },
        })
      : undefined

  if (wakeDispatcher !== undefined) {
    wakeDispatcher.start({ intervalMs: 2_000 })
  }

  const interfaceDispatcherIntervalMs = Number(
    process.env['ACP_INTERFACE_DISPATCHER_INTERVAL_MS'] || DEFAULT_INTERFACE_DISPATCHER_INTERVAL_MS
  )
  const interfaceDispatcherStaleTimeoutMs = Number(
    process.env['ACP_INTERFACE_DISPATCHER_STALE_TIMEOUT_MS'] ||
      DEFAULT_INTERFACE_DISPATCHER_STALE_TIMEOUT_MS
  )
  const interfaceDispatcherDispatchStaleTimeoutMs = Number(
    process.env['ACP_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS'] ||
      DEFAULT_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS
  )
  const interfaceRunDispatcher =
    resolvedDeps.launchRoleScopedRun !== undefined
      ? createInterfaceRunDispatcher({
          runStore: resolvedDeps.runStore,
          interfaceStore,
          ...(jobsStore !== undefined ? { jobsStore } : {}),
          conversationStore,
          hrcDbPath: resolveDatabasePath(),
          config: {
            intervalMs: interfaceDispatcherIntervalMs,
            staleTimeoutMs: interfaceDispatcherStaleTimeoutMs,
            dispatchStaleTimeoutMs: interfaceDispatcherDispatchStaleTimeoutMs,
          },
        })
      : undefined

  if (interfaceRunDispatcher !== undefined) {
    interfaceRunDispatcher.start()
  }

  const inputQueueDispatcherIntervalMs = Number(
    process.env['ACP_INPUT_QUEUE_DISPATCHER_INTERVAL_MS'] ||
      DEFAULT_INPUT_QUEUE_DISPATCHER_INTERVAL_MS
  )
  const inputQueueStalePendingRunTimeoutMs = Number(
    process.env['ACP_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS'] ||
      DEFAULT_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS
  )
  const inputQueueLeaseTimeoutMs = Number(
    process.env['ACP_INPUT_QUEUE_LEASE_TIMEOUT_MS'] || DEFAULT_INPUT_QUEUE_LEASE_TIMEOUT_MS
  )
  const inputQueueDispatcher =
    resolvedDeps.launchRoleScopedRun !== undefined
      ? createInputQueueDispatcher({
          adminStore: resolvedDeps.adminStore,
          hrcClient: resolvedDeps.hrcClient,
          inputAdmissionStore: resolvedDeps.inputAdmissionStore,
          inputQueueStore: resolvedDeps.inputQueueStore,
          ...(jobsStore !== undefined ? { jobsStore } : {}),
          runStore: resolvedDeps.runStore,
          runtimeResolver: resolvedDeps.runtimeResolver,
          inputQueuePolicy: resolvedDeps.inputQueuePolicy,
          launchRoleScopedRun: resolvedDeps.launchRoleScopedRun,
          hrcDbPath: resolveDatabasePath(),
          config: {
            intervalMs: inputQueueDispatcherIntervalMs,
            stalePendingRunTimeoutMs: inputQueueStalePendingRunTimeoutMs,
            leaseTimeoutMs: inputQueueLeaseTimeoutMs,
          },
        })
      : undefined

  if (inputQueueDispatcher !== undefined) {
    inputQueueDispatcher.start()
  }

  const schedulerEnabled = isEnabledEnvFlag(process.env['ACP_SCHEDULER_ENABLED'])
  const jobsScheduler =
    jobsStore !== undefined && schedulerEnabled
      ? createJobsScheduler({
          store: jobsStore,
          dispatchThroughInputs: (input) => dispatchJobRunThroughInputs(resolvedDeps, input),
          advanceFlowJobRun: (entry) =>
            advanceJobFlow({
              deps: resolvedDeps,
              job: entry.job,
              jobRun: entry.jobRun,
            }),
          evaluateEventJob: createEventJobEvaluator(),
        })
      : undefined
  const jobLifecycleEmitter =
    jobsStore !== undefined
      ? createJobLifecycleEmitter({
          systemEvents: resolvedDeps.adminStore.systemEvents,
          jobsStore,
          resolveFinalText: (runId) =>
            getRunFinalAssistantText(
              {
                getRun: (id) => resolvedDeps.runStore.getRun(id),
                hrcDbPath: resolveDatabasePath(),
              },
              runId
            ),
        })
      : undefined
  const jobOutputReconciler =
    jobsStore !== undefined && schedulerEnabled
      ? createJobOutputReconciler({
          jobsStore,
          runStore: resolvedDeps.runStore,
          interfaceStore: resolvedDeps.interfaceStore,
          ...(jobLifecycleEmitter !== undefined
            ? {
                onJobRunSettled: (run, job) => {
                  jobLifecycleEmitter.reconcile(run, job)
                },
              }
            : {}),
        })
      : undefined
  const pbcWorkerRunner = schedulerEnabled
    ? createPbcWorkerRunner({ deps: resolvedDeps, wrkqStore, options })
    : undefined
  const pbcWorkerScheduler =
    pbcWorkerRunner !== undefined
      ? createPbcWorkerScheduler({
          stateStore,
          runWorker: pbcWorkerRunner,
        })
      : undefined
  let schedulerTickInProgress = false
  const schedulerTimer =
    jobsScheduler !== undefined ||
    jobOutputReconciler !== undefined ||
    pbcWorkerScheduler !== undefined
      ? setInterval(() => {
          if (schedulerTickInProgress) {
            return
          }
          schedulerTickInProgress = true
          void Promise.resolve()
            .then(async () => {
              if (jobsScheduler !== undefined) {
                // tick() returns every job-run it touched this tick (scheduled
                // dispatch, dispatch_failed, flow advance, flow_advance_failed,
                // inflight flow re-advance). Project lifecycle telemetry from the
                // committed results — idempotent, so re-seen inflight runs no-op.
                const touched = await jobsScheduler.tick(new Date())
                if (jobLifecycleEmitter !== undefined) {
                  for (const run of touched) {
                    jobLifecycleEmitter.reconcile(run)
                  }
                }
              }
              if (jobOutputReconciler !== undefined) {
                await jobOutputReconciler.runOnce()
              }
            })
            .catch((error) => {
              console.error(
                'acp-server jobs scheduler tick failed:',
                error instanceof Error ? error.message : String(error)
              )
            })
            .then(async () => {
              if (pbcWorkerScheduler !== undefined) {
                await pbcWorkerScheduler.tick()
              }
            })
            .catch((error) => {
              console.error(
                'acp-server PBC worker scheduler tick failed:',
                error instanceof Error ? error.message : String(error)
              )
            })
            .finally(() => {
              schedulerTickInProgress = false
            })
        }, DEFAULT_JOBS_SCHEDULER_INTERVAL_MS)
      : undefined

  let closed = false
  return {
    startupLine: formatStartupLine(options),
    async shutdown(): Promise<void> {
      if (closed) {
        return
      }

      closed = true
      if (wakeDispatcher !== undefined) {
        await wakeDispatcher.stop()
      }
      if (interfaceRunDispatcher !== undefined) {
        await interfaceRunDispatcher.stop()
      }
      if (inputQueueDispatcher !== undefined) {
        await inputQueueDispatcher.stop()
      }
      if (schedulerTimer !== undefined) {
        clearInterval(schedulerTimer)
      }
      bunServer.stop(true)
      // The wrkq store adapter holds no resources of its own; the underlying
      // WorkClient is closed by wrkfLifecycle.close() below.
      coordStore.close()
      adminStore?.close()
      jobsStore?.close()
      conversationStore?.close()
      interfaceStore.close()
      stateStore.close()
      await capabilityHost.shutdown()
      await wrkfLifecycle.close()
    },
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let runtime: Awaited<ReturnType<typeof startAcpServeBin>> | undefined

  try {
    const resolved = resolveCliOptions(args)
    if (resolved.help) {
      console.log(renderHelp())
      return 0
    }

    runtime = await startAcpServeBin(resolved.options)
    console.log(runtime.startupLine)

    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) {
        return
      }

      shuttingDown = true
      if (runtime !== undefined) {
        await runtime.shutdown()
      }
      process.exit(0)
    }

    process.on('SIGINT', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
    return 0
  } catch (error) {
    if (runtime !== undefined) {
      await runtime.shutdown()
    }

    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await main()
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}
