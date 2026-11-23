import { parseScopeRef } from 'agent-scope'
import type { StartRuntimeRequest, StartRuntimeResponse } from 'hrc-sdk'
import type { AcpHrcClient, AcpRuntimePlacement, AcpServerDeps } from '../../src/deps.js'
import { deriveMobileSessionIdempotencyKey } from '../../src/handlers/mobile-sessions-create.js'
import { type WiredServerFixture, withWiredServer } from './wired-server.js'

export const BASE_SCOPE_REF = 'agent:mable:project:hrc-runtime:task:primary'
const CLAIMED_SCOPE_REF = 'agent:mable:project:hrc-runtime:task:primary-nova'
export const BASE_SESSION_REF = `${BASE_SCOPE_REF}/lane:main`
export const CLAIMED_SESSION_REF = `${CLAIMED_SCOPE_REF}/lane:main`
export const REQUEST_ID = 'ios-press-01879d8f'
export const TEST_AGENT_ROOT = new URL('./mobile-agent/', import.meta.url).pathname

/**
 * Mirrors what HRC reports back: a suffix start claims a roster slot near the
 * base scope, while an exact start can only ever claim the scope it was given.
 */
function startedResponse(request: StartRuntimeRequest, replayed: boolean): StartRuntimeResponse {
  const exactSessionRef = (request as { sessionRef?: string }).sessionRef
  const claimedSessionRef = exactSessionRef ?? CLAIMED_SESSION_REF
  const claimedScopeRef = claimedSessionRef.slice(0, claimedSessionRef.indexOf('/lane:'))
  return {
    runtimeId: 'rt-mobile-new-session',
    hostSessionId: 'hsid-mobile-new-session',
    transport: 'headless',
    status: 'ready',
    supportsInFlightInput: false,
    claim: {
      identity: parseScopeRef(claimedScopeRef),
      slot: claimedScopeRef.slice(claimedScopeRef.lastIndexOf(':task:') + ':task:'.length),
      scopeRef: claimedScopeRef,
      sessionRef: claimedSessionRef,
      hostSessionId: 'hsid-mobile-new-session',
      idempotencyKey:
        (request as { idempotencyKey?: string }).idempotencyKey ??
        deriveMobileSessionIdempotencyKey(REQUEST_ID),
      replayed,
    },
  }
}

/**
 * T-08572 declaration double. Mirrors the pinned sync helper's observable
 * output for the fixture profile (see evidence/baseline/u2-fixture.json) so
 * the pre-existing tests keep proving today's wire shapes.
 */
export function defaultDeclarationResolution(request: Record<string, unknown>) {
  return {
    intent: {
      harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
      execution: { preferredMode: 'headless' },
      placement: { agentRoot: request['agentRoot'] },
    },
    declaration: {
      release: { releaseId: 'test-release', sourceCommit: 'test-commit' },
      agentSources: {
        ...((request['agentSources'] as Record<string, unknown> | undefined) ?? {}),
        provenance: 'caller-agent-root',
      },
      source: {
        agentProfile: 'valid',
        projectTargets: 'valid',
        selectedTarget: 'valid',
        priming: 'valid',
      },
      warnings: [] as string[],
    },
  }
}

export function createMobileSessionHrcClient(
  input: {
    onStart?: ((request: StartRuntimeRequest) => void) | undefined
    startError?: Error | undefined
    resolveImpl?: (
      request: Record<string, unknown>
    ) => Record<string, unknown> | Promise<Record<string, unknown>>
    resolveError?: unknown
  } = {}
): {
  client: AcpHrcClient
  resolveCalls: Record<string, unknown>[]
  starts: StartRuntimeRequest[]
} {
  const resolveCalls: Record<string, unknown>[] = []
  const starts: StartRuntimeRequest[] = []
  let calls = 0
  const client = {
    resolveRuntimeIntent: async (request: Record<string, unknown>) => {
      resolveCalls.push(request)
      if (input.resolveError !== undefined) throw input.resolveError
      if (input.resolveImpl !== undefined) return input.resolveImpl(request)
      return defaultDeclarationResolution(request)
    },
    startRuntime: async (request: StartRuntimeRequest) => {
      starts.push(request)
      input.onStart?.(request)
      if (input.startError !== undefined) throw input.startError
      return startedResponse(request, calls++ > 0)
    },
  } as unknown as AcpHrcClient
  return { client, resolveCalls, starts }
}

const MOBILE_BODY = {
  agentId: 'mable',
  projectId: 'hrc-runtime',
  requestId: REQUEST_ID,
}

function runtimeResolver(): AcpRuntimePlacement {
  return {
    agentRoot: TEST_AGENT_ROOT,
    projectRoot: '/tmp/praesidium-test-projects/hrc-runtime',
    cwd: '/tmp/praesidium-test-projects/hrc-runtime',
    runMode: 'task',
  }
}

export function withMobileSessionServer(
  run: (fixture: {
    post(overrides?: Record<string, unknown>): Promise<Response>
    json: WiredServerFixture['json']
  }) => Promise<void>,
  hrcClient: AcpHrcClient,
  hrcAgentSources?: AcpServerDeps['hrcAgentSources'],
  hrcRoutes?: AcpServerDeps['hrcRoutes']
): Promise<void> {
  return withWiredServer(
    ({ request, json }) =>
      run({
        post: (overrides) =>
          request({
            method: 'POST',
            path: '/v1/mobile/sessions',
            body: { ...MOBILE_BODY, ...overrides },
          }),
        json,
      }),
    {
      hrcClient,
      runtimeResolver,
      hrcRoutes,
      ...(hrcAgentSources === undefined ? {} : { hrcAgentSources }),
    }
  )
}
