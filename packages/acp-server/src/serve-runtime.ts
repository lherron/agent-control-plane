import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openSqliteAdminStore } from 'acp-admin-store'
import { startAcpCapabilityHost } from 'acp-capability-host'
import { openSqliteConversationStore } from 'acp-conversation'
import { writeLogLine } from 'acp-core'
import { openInterfaceStore } from 'acp-interface-store'
import { openSqliteJobsStore } from 'acp-jobs-store'
import { openAcpStateStore } from 'acp-state-store'
import { openCoordinationStore } from 'coordination-substrate'
import { createAspcService } from 'spaces-aspc'
import { createCollaborationLedger } from 'wrkq-lib'
import { createAccessLogger } from './access-log.js'
import { createAcpListenerHandlers } from './acp-listener.js'
import { c2ConfigFromEnv } from './c2/controller-host.js'
import { createAcpServer } from './create-acp-server.js'
import { resolveAcpServerDeps } from './deps.js'
import {
  createAgentInspectionProjectRootResolver,
  loadWrkqProjectRegistry,
} from './handlers/agent-inspection.js'
import { ensureDispatchTimeoutHealthJob } from './jobs/health-dispatch-timeout.js'
import { ensureHrcFirstTurnMissingJob } from './jobs/hrc-first-turn-missing.js'
import {
  createJobNodeIdentityAuthority,
  stampLegacyJobRunsAfterIdentity,
} from './jobs/node-identity.js'
import { resolveLauncherDeps } from './launcher-deps.js'
import { resolveMobileAuthStore } from './mobile-auth/store.js'
import { reportReadinessExclusion, startServeWorkers } from './serve-workers.js'
import {
  type AcpServerCliOptions,
  DEFAULT_CAP_CATALOG_STATE_DIR,
  bindAcpHostListeners,
  formatStartupConfig,
  isEnabledEnvFlag,
  readPositiveIntegerEnv,
  resolveAcpBaseUrl,
  resolveAttachmentBaseUrl,
  resolveBindHosts,
  resolveCapSocketPath,
} from './server-config.js'
import { StoreCommitBus } from './store-commit-bus.js'
import { createWrkfClientLifecycle } from './wrkf/client-lifecycle.js'
import type { CommitWaker } from './wrkq-commit-waker.js'

/**
 * Normalize ACP-server's actor id into a wrkq principal ref (T-05381). wrkq's
 * principal-only attribution requires the `agent:<id>` form; a bare slug is
 * rejected. Already-prefixed values pass through unchanged.
 */
function toPrincipalRef(actor: string): string {
  const trimmed = actor.trim()
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`
}

const ACP_SERVER_VERSION = '0.1.0'

export async function startAcpServeBin(options: AcpServerCliOptions): Promise<{
  shutdown(): Promise<void>
  startupConfig: Record<string, unknown>
  commitWaker: CommitWaker | undefined
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

  const commitBus = new StoreCommitBus()
  const coordStore = openCoordinationStore(options.coordDbPath, (tables) => {
    if (tables.has('wake_requests') || tables.has('*')) commitBus.notify('coordination')
  })
  const interfaceStore = openInterfaceStore({
    dbPath: options.interfaceDbPath,
    onCommit: (tables) => {
      if (tables.has('delivery_requests') || tables.has('outbound_attachments') || tables.has('*'))
        commitBus.notify('deliveries')
    },
  })
  const stateStore = openAcpStateStore({
    dbPath: options.stateDbPath,
    onCommit: (tables) => {
      if (tables.has('runs') || tables.has('*')) commitBus.notify('runs')
      if (
        [
          'input_attempts',
          'input_admissions',
          'input_applications',
          'input_queue',
          'session_admission_sequence',
          '*',
        ].some((table) => tables.has(table))
      )
        commitBus.notify('admissions')
      if (tables.has('pbc_continuation_jobs') || tables.has('*')) commitBus.notify('jobs')
    },
  })
  const adminStore =
    options.adminDbPath !== undefined
      ? openSqliteAdminStore({
          dbPath: options.adminDbPath,
          onCommit: (tables) => {
            if (tables.has('system_events') || tables.has('*')) commitBus.notify('system-events')
          },
        })
      : undefined
  const jobsStore =
    options.jobsDbPath !== undefined
      ? openSqliteJobsStore({
          dbPath: options.jobsDbPath,
          onCommit: () => commitBus.notify('jobs'),
        })
      : undefined
  const conversationStore =
    options.conversationDbPath !== undefined
      ? openSqliteConversationStore({ dbPath: options.conversationDbPath })
      : undefined
  const launcherDeps = resolveLauncherDeps(process.env, process.cwd(), {
    inputAttemptStore: stateStore.inputAttempts,
    ...(jobsStore !== undefined ? { jobsStore } : {}),
  })
  const jobNodeIdentityAuthority =
    jobsStore !== undefined ? createJobNodeIdentityAuthority(launcherDeps.hrcClient) : undefined
  const jobIdentityStartup =
    jobNodeIdentityAuthority !== undefined ? await jobNodeIdentityAuthority.initialize() : undefined
  if (jobIdentityStartup?.ok === true) {
    // Publish excluded schedules once at baseline, including future schedules.
    // hasSchedulerWork reports only new/changed exclusions on subsequent ticks.
    jobsStore?.hasSchedulerWork(
      new Date().toISOString(),
      jobIdentityStartup.identity,
      reportReadinessExclusion
    )
  }
  if (jobIdentityStartup !== undefined && !jobIdentityStartup.ok) {
    writeLogLine({
      level: 'error',
      component: 'jobs',
      event: 'jobs.identity_baseline_unavailable',
      data: { code: jobIdentityStartup.code, message: jobIdentityStartup.message },
    })
  }
  if (jobsStore !== undefined && jobIdentityStartup !== undefined) {
    const migration = stampLegacyJobRunsAfterIdentity(jobsStore, jobIdentityStartup)
    if (migration.stamped > 0) {
      writeLogLine({
        level: 'info',
        component: 'jobs',
        event: 'jobs.legacy_runs_stamped',
        data: {
          stamped: migration.stamped,
          nodeId: jobIdentityStartup.ok ? jobIdentityStartup.identity.nodeId : 'unavailable',
        },
      })
    }
  }
  const wrkfLifecycle = await createWrkfClientLifecycle({
    ...(process.env['WRKF_BIN'] !== undefined ? { command: process.env['WRKF_BIN'] } : {}),
    // Principal-only caller attribution (T-05381): ACP-server is a single wrkq
    // principal `agent:<actor>` for all its CAS writes / workflow mutations.
    principalRef: toPrincipalRef(options.actor),
    // The one shared client owns local/remote transport for both wrkq store ports
    // and wrkf calls. ACP neither interprets the locator nor selects another DB.
    dbLocator: options.wrkqDbLocator,
    clientInfo: { name: 'acp-server', version: ACP_SERVER_VERSION },
    wrkfDisabled: isEnabledEnvFlag(process.env['ACP_WRKF_DISABLED']),
  })
  // The wrkq store ports are the @wrkq/client-backed adapter the lifecycle
  // derives from its single shared WorkClient (undefined when wrkf is disabled).
  // ACP no longer opens wrkq.db directly.
  const wrkqStore = wrkfLifecycle.store
  const collaborationLedger =
    wrkfLifecycle.client !== undefined
      ? createCollaborationLedger(wrkfLifecycle.client, toPrincipalRef(options.actor))
      : undefined
  const inputQueueMaxDepth = readPositiveIntegerEnv('ACP_INPUT_QUEUE_MAX_DEPTH')
  const inputQueueTtlMs = readPositiveIntegerEnv('ACP_INPUT_QUEUE_TTL_MS')
  const aspcService = createAspcService({
    resolveProjectRoot: createAgentInspectionProjectRootResolver({
      adminStore,
      loadRegistryProjects: () => loadWrkqProjectRegistry(wrkfLifecycle.client),
    }),
  })
  const agentInspectionAuthority = {
    catalogAgentInspection: (request: Parameters<typeof aspcService.catalogAgentInspection>[0]) =>
      aspcService.catalogAgentInspection(request),
    inspectAgentSelection: (request: Parameters<typeof aspcService.inspectAgentSelection>[0]) =>
      aspcService.inspectAgentSelection(request),
  }
  const serverDeps = {
    ...(wrkqStore !== undefined ? { wrkqStore } : {}),
    coordStore,
    commitBus,
    ...(adminStore !== undefined ? { adminStore } : {}),
    ...(jobsStore !== undefined ? { jobsStore } : {}),
    ...(conversationStore !== undefined ? { conversationStore } : {}),
    agentInspectionAuthority,
    interfaceStore,
    stateStore,
    ...launcherDeps,
    // T-12207: the C2 cards host is always on where this instance has HRC.
    ...(launcherDeps.hrcClient !== undefined ? { c2: c2ConfigFromEnv() } : {}),
    ...(jobNodeIdentityAuthority !== undefined ? { jobNodeIdentityAuthority } : {}),
    ...(inputQueueMaxDepth !== undefined || inputQueueTtlMs !== undefined
      ? {
          inputQueuePolicy: {
            ...(inputQueueMaxDepth !== undefined ? { maxDepth: inputQueueMaxDepth } : {}),
            ...(inputQueueTtlMs !== undefined ? { ttlMs: inputQueueTtlMs } : {}),
          },
        }
      : {}),
    agentAssetsDir: options.agentAssetsDir,
    attachmentBaseUrl: resolveAttachmentBaseUrl(options),
    commitWaker: wrkfLifecycle.commitWaker,
    ...(wrkfLifecycle.client !== undefined ? { workClient: wrkfLifecycle.client } : {}),
    ...(wrkfLifecycle.principalRef !== undefined
      ? { workClientPrincipalRef: wrkfLifecycle.principalRef }
      : {}),
    workClientForPrincipal: (principalRef: string) =>
      wrkfLifecycle.clientForPrincipal(principalRef),
    ...(collaborationLedger !== undefined ? { collaborationLedger } : {}),
    ...(wrkfLifecycle.client !== undefined
      ? {
          collaborationLedgerForPrincipal: async (principalRef: string) =>
            createCollaborationLedger(
              await wrkfLifecycle.clientForPrincipal(principalRef),
              principalRef
            ),
        }
      : {}),
    wrkf: wrkfLifecycle.wrkf,
  }
  const capabilityHost = await startAcpCapabilityHost({
    capabilitiesDir:
      process.env['ACP_CAPABILITIES_DIR']?.trim() || join(process.cwd(), 'capabilities'),
    socketPath: resolveCapSocketPath(process.env),
    catalogStateDir:
      process.env['ACP_CAP_CATALOG_STATE_DIR']?.trim() || DEFAULT_CAP_CATALOG_STATE_DIR,
    acpBaseUrl,
    logger: (message) =>
      writeLogLine({
        level: 'info',
        component: 'acp-capability-host',
        event: 'capability_host.log',
        data: { message },
      }),
  })
  // One store instance for the whole daemon: `serverDeps` is resolved twice (HTTP
  // router + WS upgrade path), and two stores over one flat file would mean two
  // writers and a gate that could disagree with itself between HTTP and WS.
  serverDeps.mobileAuthStore = resolveMobileAuthStore()
  const acpServer = createAcpServer(serverDeps)
  const resolvedDeps = resolveAcpServerDeps(serverDeps)
  if (jobsStore !== undefined) {
    ensureDispatchTimeoutHealthJob(jobsStore)
    ensureHrcFirstTurnMissingJob(jobsStore)
  }
  const accessLogger = await createAccessLogger(process.env['ACP_ACCESS_LOG_PATH'])
  // Every bind host is the one `main` listener for the request log.
  const listenerHandlers = createAcpListenerHandlers({
    acpServer,
    deps: resolvedDeps,
    handleCapRpc: (request) => capabilityHost.handleHttpJsonRpc(request),
    accessLogger,
  })
  const bindHosts = resolveBindHosts(options.host)
  const bunServers = bindAcpHostListeners(
    bindHosts,
    (host) =>
      Bun.serve({
        hostname: host,
        port: options.port,
        idleTimeout: 255,
        ...listenerHandlers,
      }),
    options.port
  )
  const { wakeDispatcher, interfaceRunDispatcher, inputQueueDispatcher, schedulerLoop } =
    startServeWorkers({ resolvedDeps, stateStore, commitBus, wrkqStore, options })

  let closed = false
  return {
    startupConfig: formatStartupConfig(options),
    commitWaker: wrkfLifecycle.commitWaker,
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
      await schedulerLoop?.stop()
      commitBus.close()
      for (const bunServer of bunServers) {
        bunServer.stop(true)
      }
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
