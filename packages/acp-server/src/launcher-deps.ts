import { writeLogLine } from 'acp-core'
import type { JobsStore } from 'acp-jobs-store'
import { type SessionRef, parseScopeRef } from 'agent-scope'
import { resolveControlSocketPath } from 'hrc-core'
import type { createAcpServer } from './create-acp-server.js'
import type {
  AcpHrcClient,
  AcpRuntimePlacement,
  HrcAgentSources,
  InputAttemptStore,
} from './deps.js'
import { createEchoLauncher } from './echo-launcher.js'
import { AcpHrcSdkClient } from './hrc-client.js'
import { lastObservedActivityMs } from './integration/interface-run-dispatcher.js'
import { createJobFirstBirthAuthority } from './jobs/first-birth-authority.js'
import {
  type FetchPlacementResolution,
  type FetchRunPreview,
  fetchPlacementResolution,
  fetchRunPreview,
} from './placement-resolution.js'
import { createRealLauncher } from './real-launcher.js'
import { ACP_SERVER_USER_AGENT } from './user-agent.js'

export interface ResolveLauncherDepsOptions {
  createHrcClient?: ((socketPath: string) => AcpHrcClient) | undefined
  inputAttemptStore?: InputAttemptStore | undefined
  /** Vouches for job runs that may first-birth their unbound target (T-09993). */
  jobsStore?: JobsStore | undefined
  placementSocketPath?: string | undefined
  placementFetch?: FetchPlacementResolution | undefined
  runPreviewFetch?: FetchRunPreview | undefined
}

export async function resolveRealLauncherAgentRoot(
  agentId: string,
  input: {
    cwd?: string | undefined
    scopeRef?: string | undefined
    socketPath?: string | undefined
    fetchPlacement?: FetchPlacementResolution | undefined
  } = {}
): Promise<string> {
  const fetch = input.fetchPlacement ?? fetchPlacementResolution
  const fetchOpts: { socketPath?: string | undefined } = {}
  if (input.socketPath !== undefined) fetchOpts.socketPath = input.socketPath
  const resolved = await fetch(
    {
      ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : { agentId }),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    },
    fetchOpts
  )
  return resolved.agentRoot
}

export async function resolveRealLauncherPlacement(
  sessionRef: SessionRef,
  input: {
    cwd?: string | undefined
    socketPath?: string | undefined
    fetchPlacement?: FetchPlacementResolution | undefined
  } = {}
): Promise<AcpRuntimePlacement | undefined> {
  const fetch = input.fetchPlacement ?? fetchPlacementResolution
  const fetchOpts: { socketPath?: string | undefined } = {}
  if (input.socketPath !== undefined) fetchOpts.socketPath = input.socketPath
  const parsedScope = parseScopeRef(sessionRef.scopeRef)
  const resolved = await fetch(
    {
      scopeRef: sessionRef.scopeRef,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      runMode: 'task',
    },
    fetchOpts
  )

  if (parsedScope.projectId !== undefined && resolved.projectRoot === undefined) {
    // A project-scoped placement without its checkout root is not a usable
    // placement. The daemon reports unknown projects as declaration_invalid;
    // this guard fails closed on forward shape drift instead of minting a
    // harness in the agent home.
    return undefined
  }

  const projectRoot = resolved.projectRoot
  const cwd = projectRoot ?? resolved.cwd ?? resolved.agentRoot

  return {
    agentRoot: resolved.agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    cwd,
    runMode: 'task',
    bundle: resolved.bundle,
  }
}

function toHrcSessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneRef}`
}

function readCommandTargetId(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value && value.length > 0 ? value : undefined
}

function readHrcAgentSources(env: NodeJS.ProcessEnv): HrcAgentSources | undefined {
  const agentsRoot = env['ASP_AGENTS_ROOT']?.trim()
  const aspHome = env['ASP_HOME']?.trim()
  if (
    (agentsRoot === undefined || agentsRoot === '') &&
    (aspHome === undefined || aspHome === '')
  ) {
    return undefined
  }
  return {
    ...(agentsRoot !== undefined && agentsRoot !== '' ? { agentsRoot } : {}),
    ...(aspHome !== undefined && aspHome !== '' ? { aspHome } : {}),
  }
}

export function resolveLauncherDeps(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  _options: ResolveLauncherDepsOptions = {}
): Partial<Parameters<typeof createAcpServer>[0]> {
  const useRealLauncher = env['ACP_REAL_HRC_LAUNCHER'] === '1'
  const useEchoLauncher = env['ACP_DEV_ECHO_LAUNCHER'] === '1'

  if (useRealLauncher) {
    if (useEchoLauncher) {
      writeLogLine({
        level: 'warn',
        component: 'acp-server',
        event: 'server.config.ignored',
        data: { variable: 'ACP_DEV_ECHO_LAUNCHER', reason: 'ACP_REAL_HRC_LAUNCHER=1' },
      })
    }

    const createHrcClient =
      _options.createHrcClient ??
      ((socketPath: string) =>
        new AcpHrcSdkClient({
          socketPath,
          userAgent: ACP_SERVER_USER_AGENT,
          caller: 'acp-server',
        }) as unknown as AcpHrcClient)
    const socketPath = resolveControlSocketPath()
    const placementSocketOpts =
      _options.placementSocketPath !== undefined ? { socketPath: _options.placementSocketPath } : {}
    const placementFetch: FetchPlacementResolution =
      _options.placementFetch ??
      ((input, opts = {}) =>
        fetchPlacementResolution(input, {
          ...opts,
          ...(placementSocketOpts.socketPath !== undefined
            ? { socketPath: placementSocketOpts.socketPath }
            : {}),
        }))
    const hrcClient: AcpHrcClient = createHrcClient(socketPath)
    // T-13243: launcher evidence, sweeps and the reaper read HRC's routes.
    const hrcRoutes = new AcpHrcSdkClient({
      socketPath,
      userAgent: ACP_SERVER_USER_AGENT,
      caller: 'acp-server:evidence',
    })
    const hrcAgentSources = readHrcAgentSources(env)
    const triageCommandTargetId = readCommandTargetId(env, 'ACP_TRIAGE_COMMAND_TARGET_ID')
    const implCommandTargetId = readCommandTargetId(env, 'ACP_IMPL_COMMAND_TARGET_ID')
    const verifyCommandTargetId = readCommandTargetId(env, 'ACP_VERIFY_COMMAND_TARGET_ID')
    const hasCommandTarget =
      triageCommandTargetId !== undefined ||
      implCommandTargetId !== undefined ||
      verifyCommandTargetId !== undefined

    return {
      launchRoleScopedRun: createRealLauncher({
        inputAttemptStore: _options.inputAttemptStore,
        ...(_options.jobsStore !== undefined
          ? { jobFirstBirthAuthority: createJobFirstBirthAuthority(_options.jobsStore) }
          : {}),
      }),
      hrcRoutes,
      runLivenessResolver: async (run) =>
        new Date(await lastObservedActivityMs(run, hrcRoutes)).toISOString(),
      ...(triageCommandTargetId !== undefined ? { triageCommandTargetId } : {}),
      ...(implCommandTargetId !== undefined ? { implCommandTargetId } : {}),
      ...(verifyCommandTargetId !== undefined ? { verifyCommandTargetId } : {}),
      ...(hasCommandTarget
        ? {
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
      runtimeResolver: (sessionRef) =>
        resolveRealLauncherPlacement(sessionRef, {
          cwd,
          ...placementSocketOpts,
          fetchPlacement: placementFetch,
        }),
      agentRootResolver: ({ agentId, sessionRef }) =>
        resolveRealLauncherAgentRoot(agentId, {
          cwd,
          scopeRef: sessionRef.scopeRef,
          ...placementSocketOpts,
          fetchPlacement: placementFetch,
        }),
      placementFetch,
      runPreviewFetch:
        _options.runPreviewFetch ??
        ((input, opts = {}) =>
          fetchRunPreview(input, {
            ...opts,
            ...(placementSocketOpts.socketPath !== undefined
              ? { socketPath: placementSocketOpts.socketPath }
              : {}),
          })),
      hrcClient,
      ...(hrcAgentSources !== undefined ? { hrcAgentSources } : {}),
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

  if (useEchoLauncher) {
    return {
      launchRoleScopedRun: createEchoLauncher(),
      agentRootResolver: ({ agentId }) => `/tmp/acp-dev-echo/${agentId}`,
    }
  }

  return {}
}
