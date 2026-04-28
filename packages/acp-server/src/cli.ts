#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { openSqliteAdminStore } from 'acp-admin-store'
import { openSqliteConversationStore } from 'acp-conversation'
import { openInterfaceStore } from 'acp-interface-store'
import { createJobsScheduler, openSqliteJobsStore } from 'acp-jobs-store'
import { openAcpStateStore } from 'acp-state-store'
import { type SessionRef, parseScopeRef } from 'agent-scope'
import { openCoordinationStore } from 'coordination-substrate'
import { resolveControlSocketPath } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { buildRuntimeBundleRef, getAgentsRoot, resolveAgentPlacementPaths } from 'spaces-config'
import { WrkqSchemaMissingError, openWrkqStore } from 'wrkq-lib'

import { createAcpServer } from './create-acp-server.js'
import {
  type AcpHrcClient,
  type AcpRuntimePlacement,
  DEFAULT_INTERFACE_DB_PATH,
  DEFAULT_STATE_DB_PATH,
  resolveAcpServerDeps,
} from './deps.js'
import { createDevFlowLauncher } from './dev-flow-launcher.js'
import { createEchoLauncher } from './echo-launcher.js'
import { dispatchJobRunThroughInputs } from './handlers/admin-jobs.js'
import { createWakeDispatcher } from './integration/wake-dispatcher.js'
import { advanceJobFlow } from './jobs/flow-engine.js'
import { createRealLauncher } from './real-launcher.js'

const DEFAULT_COORD_DB_PATH = '/Users/lherron/praesidium/var/db/acp-coordination.db'
const DEFAULT_PORT = 18470
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_ACTOR = 'acp-server'
const DEFAULT_JOBS_SCHEDULER_INTERVAL_MS = 5_000

export function isEnabledEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
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
  ].join(' ')
}

export function renderHelp(): string {
  return [
    'acp-server — Bun.serve wrapper around packages/acp-server',
    '',
    'Usage:',
    '  acp-server [--wrkq-db-path <path>] [--coord-db-path <path>] [--interface-db-path <path>] [--state-db-path <path>] [--admin-db-path <path>] [--jobs-db-path <path>] [--conversation-db-path <path>] [--host <host>] [--port <port>] [--actor <agentId>]',
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
    `  ACP_HOST          Defaults to ${DEFAULT_HOST}`,
    `  ACP_PORT          Defaults to ${DEFAULT_PORT}`,
    `  ACP_ACTOR         Defaults to WRKQ_ACTOR or ${DEFAULT_ACTOR}`,
  ].join('\n')
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
      _options.createHrcClient ?? ((socketPath: string) => new HrcClient(socketPath))
    const socketPath = resolveControlSocketPath()
    const hrcClient: AcpHrcClient = createHrcClient(socketPath)

    return {
      launchRoleScopedRun: createRealLauncher(),
      runtimeResolver: (sessionRef) => resolveRealLauncherPlacement(sessionRef, { cwd, env }),
      agentRootResolver: ({ agentId }) => resolveRealLauncherAgentRoot(agentId, { cwd, env }),
      hrcClient,
      sessionResolver: async (sessionRef) => {
        const result = await hrcClient.resolveSession({
          sessionRef: toHrcSessionRef(sessionRef.scopeRef, sessionRef.laneRef),
        })
        return result.hostSessionId
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

export async function startAcpServeBin(options: AcpServerCliOptions): Promise<{
  shutdown(): Promise<void>
  startupLine: string
}> {
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

  const wrkqStore = openWrkqStore({
    dbPath: options.wrkqDbPath,
    actor: { agentId: options.actor },
  })
  const coordStore = openCoordinationStore(options.coordDbPath)
  const interfaceStore = openInterfaceStore({
    dbPath: options.interfaceDbPath,
    actor: { agentId: options.actor },
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
  const serverDeps = {
    wrkqStore,
    coordStore,
    ...(adminStore !== undefined ? { adminStore } : {}),
    ...(jobsStore !== undefined ? { jobsStore } : {}),
    ...(conversationStore !== undefined ? { conversationStore } : {}),
    interfaceStore,
    stateStore,
    ...launcherDeps,
  }
  const acpServer = createAcpServer(serverDeps)
  const bunServer = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: acpServer.handler,
  })

  const resolvedDeps = resolveAcpServerDeps(serverDeps)
  const wakeDispatcher =
    resolvedDeps.launchRoleScopedRun !== undefined && resolvedDeps.runtimeResolver !== undefined
      ? createWakeDispatcher({
          coordStore,
          inputAttemptStore: resolvedDeps.inputAttemptStore,
          runStore: resolvedDeps.runStore,
          runtimeResolver: resolvedDeps.runtimeResolver,
          launchRoleScopedRun: resolvedDeps.launchRoleScopedRun,
        })
      : undefined

  if (wakeDispatcher !== undefined) {
    wakeDispatcher.start({ intervalMs: 2_000 })
  }

  const jobsScheduler =
    jobsStore !== undefined && isEnabledEnvFlag(process.env['ACP_SCHEDULER_ENABLED'])
      ? createJobsScheduler({
          store: jobsStore,
          dispatchThroughInputs: (input) => dispatchJobRunThroughInputs(resolvedDeps, input),
          advanceFlowJobRun: (entry) =>
            advanceJobFlow({
              deps: resolvedDeps,
              job: entry.job,
              jobRun: entry.jobRun,
            }),
        })
      : undefined
  const jobsSchedulerTimer =
    jobsScheduler !== undefined
      ? setInterval(() => {
          void jobsScheduler.tick(new Date()).catch((error) => {
            console.error(
              'acp-server jobs scheduler tick failed:',
              error instanceof Error ? error.message : String(error)
            )
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
      if (jobsSchedulerTimer !== undefined) {
        clearInterval(jobsSchedulerTimer)
      }
      bunServer.stop(true)
      wrkqStore.close()
      coordStore.close()
      adminStore?.close()
      jobsStore?.close()
      conversationStore?.close()
      interfaceStore.close()
      stateStore.close()
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

    if (error instanceof WrkqSchemaMissingError) {
      console.error(`${error.message}\nRequired migration: 000013_task_workflow_schema.sql`)
      return 1
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
