import { describe, expect, test } from 'bun:test'

import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

type RuntimeIntentLike = {
  placement?: Record<string, unknown> | undefined
  launch?: { env?: Record<string, string> | undefined } | undefined
  harness?: { provider?: string | undefined; interactive?: boolean | undefined } | undefined
  execution?: { preferredMode?: string | undefined } | undefined
  initialPrompt?: string | undefined
}

type ResolveSessionRequest = {
  sessionRef: string
  runtimeIntent: RuntimeIntentLike
}

type StartRuntimeRequest = {
  hostSessionId: string
  intent: RuntimeIntentLike
  restartStyle: string
}

type RuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  transport: string
  harness: string
  provider: string
  status: string
  supportsInflightInput: boolean
  adopted: boolean
  createdAt: string
  updatedAt: string
}

type AttachDescriptor = {
  runtimeId: string
  transport: string
  command: string[]
}

type HrcClientWithStartRuntime = AcpHrcClient & {
  startRuntime(request: StartRuntimeRequest): Promise<RuntimeResponse>
}

const openEndedScopeRef = 'agent:supervisor:project:agent-spaces'
// agent-scope canonical task conversations use :task:<taskId>; CLI shorthands must normalize before POSTing.
const taskScopeRef = 'agent:supervisor:project:agent-spaces:task:T-01410'
const sessionRef = { scopeRef: openEndedScopeRef, laneRef: 'lane:main' }
const taskSessionRef = { scopeRef: taskScopeRef, laneRef: 'lane:main' }

function createRuntime(overrides: Partial<RuntimeResponse> = {}): RuntimeResponse {
  return {
    runtimeId: 'rt-workflow-interact-001',
    hostSessionId: 'hsid-runtime-authoritative',
    scopeRef: openEndedScopeRef,
    laneRef: 'main',
    generation: 3,
    transport: 'tmux',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    createdAt: '2026-05-10T22:00:00.000Z',
    updatedAt: '2026-05-10T22:00:00.000Z',
    ...overrides,
  }
}

function createAttachDescriptor(overrides: Partial<AttachDescriptor> = {}): AttachDescriptor {
  return {
    runtimeId: 'rt-workflow-interact-001',
    transport: 'tmux',
    command: ['tmux', 'attach-session', '-t', 'rt-workflow-interact-001'],
    ...overrides,
  }
}

function createHrcClientDouble(
  overrides: Partial<HrcClientWithStartRuntime>
): HrcClientWithStartRuntime {
  const notImplemented = (name: string) => async () => {
    throw new Error(`${name} not implemented`)
  }

  return {
    resolveSession:
      overrides.resolveSession ??
      (notImplemented('resolveSession') as unknown as HrcClientWithStartRuntime['resolveSession']),
    startRuntime:
      overrides.startRuntime ??
      (notImplemented('startRuntime') as unknown as HrcClientWithStartRuntime['startRuntime']),
    getAttachDescriptor:
      overrides.getAttachDescriptor ??
      (notImplemented(
        'getAttachDescriptor'
      ) as unknown as HrcClientWithStartRuntime['getAttachDescriptor']),
    listSessions:
      overrides.listSessions ??
      (notImplemented('listSessions') as unknown as HrcClientWithStartRuntime['listSessions']),
    getSession:
      overrides.getSession ??
      (notImplemented('getSession') as unknown as HrcClientWithStartRuntime['getSession']),
    clearContext:
      overrides.clearContext ??
      (notImplemented('clearContext') as unknown as HrcClientWithStartRuntime['clearContext']),
    listRuntimes:
      overrides.listRuntimes ??
      (notImplemented('listRuntimes') as unknown as HrcClientWithStartRuntime['listRuntimes']),
    capture:
      overrides.capture ??
      (notImplemented('capture') as unknown as HrcClientWithStartRuntime['capture']),
    interrupt:
      overrides.interrupt ??
      (notImplemented('interrupt') as unknown as HrcClientWithStartRuntime['interrupt']),
    terminate:
      overrides.terminate ??
      (notImplemented('terminate') as unknown as HrcClientWithStartRuntime['terminate']),
    deliverLiteralBySelector:
      overrides.deliverLiteralBySelector ??
      (notImplemented(
        'deliverLiteralBySelector'
      ) as unknown as HrcClientWithStartRuntime['deliverLiteralBySelector']),
    getHealth:
      overrides.getHealth ??
      (notImplemented('getHealth') as unknown as HrcClientWithStartRuntime['getHealth']),
    listMessages:
      overrides.listMessages ??
      (notImplemented('listMessages') as unknown as HrcClientWithStartRuntime['listMessages']),
    sendInFlightInput:
      overrides.sendInFlightInput ??
      (notImplemented(
        'sendInFlightInput'
      ) as unknown as HrcClientWithStartRuntime['sendInFlightInput']),
    watchMessages:
      overrides.watchMessages ??
      (notImplemented('watchMessages') as unknown as HrcClientWithStartRuntime['watchMessages']),
    submitActiveRunContribution:
      overrides.submitActiveRunContribution ??
      (notImplemented(
        'submitActiveRunContribution'
      ) as unknown as HrcClientWithStartRuntime['submitActiveRunContribution']),
    getActiveRunContribution:
      overrides.getActiveRunContribution ??
      (notImplemented(
        'getActiveRunContribution'
      ) as unknown as HrcClientWithStartRuntime['getActiveRunContribution']),
    watch:
      overrides.watch ??
      // biome-ignore lint/correctness/useYield: test double that throws on use
      (async function* () {
        throw new Error('watch not implemented')
      } as unknown as HrcClientWithStartRuntime['watch']),
  }
}

function placementWithoutHarness() {
  return {
    agentRoot: '/tmp/acp-test/codex/supervisor',
    projectRoot: '/tmp/acp-test/project',
    cwd: '/tmp/acp-test/project',
    runMode: 'workflow',
    bundle: { kind: 'compose', compose: [] },
  }
}

describe('POST /v1/workflow-interact-runs', () => {
  test('starts an open-ended workflow interaction and returns runtime attach details', async () => {
    const resolveSessionRequests: ResolveSessionRequest[] = []
    const startRuntimeRequests: StartRuntimeRequest[] = []
    const attachDescriptor = createAttachDescriptor()
    const runtime = createRuntime()
    const hrcClient = createHrcClientDouble({
      resolveSession: async (request) => {
        resolveSessionRequests.push(request as ResolveSessionRequest)
        return { hostSessionId: 'hsid-resolved-before-start', generation: 2 }
      },
      startRuntime: async (request) => {
        startRuntimeRequests.push(request)
        return runtime
      },
      getAttachDescriptor: async (runtimeId) => {
        expect(runtimeId).toBe(runtime.runtimeId)
        return attachDescriptor
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-interact-runs',
          body: {
            sessionRef,
            workflowInteract: true,
            initialPrompt: 'Collaborate on the next workflow step.',
          },
        })
        const payload = await fixture.json<{
          sessionRef: string
          sessionId: string
          runtimeId: string
          runtime: RuntimeResponse
          attachDescriptor: AttachDescriptor
        }>(response)

        expect(response.status).toBe(200)
        expect(payload).toEqual({
          sessionRef: `${openEndedScopeRef}/lane:main`,
          sessionId: runtime.hostSessionId,
          runtimeId: runtime.runtimeId,
          runtime,
          attachDescriptor,
        })
        expect(resolveSessionRequests).toHaveLength(1)
        expect(resolveSessionRequests[0]?.sessionRef).toBe(`${openEndedScopeRef}/lane:main`)
        expect(resolveSessionRequests[0]?.runtimeIntent.initialPrompt).toBe(
          'Collaborate on the next workflow step.'
        )
        expect(resolveSessionRequests[0]?.runtimeIntent.launch?.env).toMatchObject({
          ACP_WORKFLOW_INTERACT: '1',
        })
        expect(startRuntimeRequests).toEqual([
          expect.objectContaining({
            hostSessionId: 'hsid-resolved-before-start',
            restartStyle: 'reuse_pty',
          }),
        ])
        expect(startRuntimeRequests[0]?.intent.launch?.env).toMatchObject({
          ACP_WORKFLOW_INTERACT: '1',
        })
      },
      { hrcClient, runtimeResolver: async () => placementWithoutHarness() }
    )
  })

  test('passes workflow task, workflow ref, and goal through launch env', async () => {
    const resolveSessionRequests: ResolveSessionRequest[] = []
    const startRuntimeRequests: StartRuntimeRequest[] = []
    const runtime = createRuntime({
      runtimeId: 'rt-workflow-interact-task-001',
      hostSessionId: 'hsid-workflow-task-runtime',
      scopeRef: taskScopeRef,
    })
    const attachDescriptor = createAttachDescriptor({ runtimeId: runtime.runtimeId })
    const hrcClient = createHrcClientDouble({
      resolveSession: async (request) => {
        resolveSessionRequests.push(request as ResolveSessionRequest)
        return { hostSessionId: 'hsid-workflow-task-resolved', generation: 5 }
      },
      startRuntime: async (request) => {
        startRuntimeRequests.push(request)
        return runtime
      },
      getAttachDescriptor: async () => attachDescriptor,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-interact-runs',
          body: {
            sessionRef: taskSessionRef,
            workflowInteract: true,
            workflowTaskId: 'T-01410',
            workflowRef: 'code_feature_tdd@1',
            workflowGoal: 'Implement signed release checks',
          },
        })

        expect(response.status).toBe(200)
        expect(resolveSessionRequests[0]?.runtimeIntent.launch?.env).toMatchObject({
          ACP_WORKFLOW_INTERACT: '1',
          ACP_WORKFLOW_TASK_ID: 'T-01410',
          ACP_WORKFLOW_REF: 'code_feature_tdd@1',
          ACP_WORKFLOW_GOAL: 'Implement signed release checks',
        })
        expect(startRuntimeRequests[0]?.intent.launch?.env).toMatchObject({
          ACP_WORKFLOW_INTERACT: '1',
          ACP_WORKFLOW_TASK_ID: 'T-01410',
          ACP_WORKFLOW_REF: 'code_feature_tdd@1',
          ACP_WORKFLOW_GOAL: 'Implement signed release checks',
        })
      },
      { hrcClient, runtimeResolver: async () => placementWithoutHarness() }
    )
  })

  test('rejects malformed sessionRef before resolving or starting a runtime', async () => {
    const hrcCalls: string[] = []
    const hrcClient = createHrcClientDouble({
      resolveSession: async () => {
        hrcCalls.push('resolveSession')
        return { hostSessionId: 'hsid-should-not-resolve', generation: 1 }
      },
      startRuntime: async () => {
        hrcCalls.push('startRuntime')
        return createRuntime()
      },
      getAttachDescriptor: async () => {
        hrcCalls.push('getAttachDescriptor')
        return createAttachDescriptor()
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-interact-runs',
          body: {
            sessionRef: { scopeRef: 'not a scope ref', laneRef: 'lane:main' },
            workflowInteract: true,
          },
        })
        const payload = await fixture.json<{ error: { code: string } }>(response)

        expect(response.status).toBe(400)
        expect(payload.error.code).toBe('malformed_request')
        expect(hrcCalls).toEqual([])
      },
      { hrcClient, runtimeResolver: async () => placementWithoutHarness() }
    )
  })

  test('normalizes a no-harness launch intent to interactive mode before startRuntime', async () => {
    const startRuntimeRequests: StartRuntimeRequest[] = []
    const hrcClient = createHrcClientDouble({
      resolveSession: async () => ({ hostSessionId: 'hsid-normalize', generation: 1 }),
      startRuntime: async (request) => {
        startRuntimeRequests.push(request)
        return createRuntime()
      },
      getAttachDescriptor: async () => createAttachDescriptor(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-interact-runs',
          body: {
            sessionRef,
            workflowInteract: true,
          },
        })

        expect(response.status).toBe(200)
        expect(startRuntimeRequests).toHaveLength(1)
        expect(startRuntimeRequests[0]?.intent.harness).toMatchObject({
          provider: 'openai',
          interactive: true,
        })
        expect(startRuntimeRequests[0]?.intent.execution).toMatchObject({
          preferredMode: 'interactive',
        })
      },
      { hrcClient, runtimeResolver: async () => placementWithoutHarness() }
    )
  })
})
