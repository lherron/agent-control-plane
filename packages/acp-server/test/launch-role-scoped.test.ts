import { describe, expect, test } from 'bun:test'

import type { Task } from 'acp-core'
import type { HrcRuntimeIntent } from 'hrc-core'

import { createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { resolveAcpServerDeps } from '../src/deps.js'
import { resolveLaunchIntent } from '../src/index.js'
import type { AcpWrkfWorkflowPort } from '../src/wrkf/port.js'
import { withWiredServer } from './fixtures/wired-server.js'

/**
 * Build a wrkf workflow port whose `task.inspect` returns the FLAT instance
 * record the real `@wrkq/client` adapter yields (wrkq.workflow.inspect →
 * unwrapped). Forward role model: preset/version/phase live on the instance,
 * NOT the task record. `templateVersion` is a STRING in the real binary.
 */
function wrkfPortWithInstance(
  instance: { templateId: string; templateVersion: string; phase?: string | null } | undefined
): AcpWrkfWorkflowPort {
  return {
    task: {
      inspect: async () => {
        if (instance === undefined) {
          throw new Error('workflow instance not found')
        }
        return instance
      },
    },
  } as unknown as AcpWrkfWorkflowPort
}

/**
 * A task shaped the way the real @wrkq/client store adapter's `getTask` returns
 * it: NO task-level workflowPreset/presetVersion and `phase: null` (those facts
 * were relocated to the wrkf instance by epic T-04763). riskClass/roleMap are
 * still task-level.
 */
function createRealAdapterTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: overrides.taskId ?? 'task-real-001',
    projectId: overrides.projectId ?? 'demo',
    kind: overrides.kind ?? 'code_change',
    lifecycleState: overrides.lifecycleState ?? 'active',
    phase: null,
    riskClass: overrides.riskClass ?? 'medium',
    roleMap: overrides.roleMap ?? { tester: 'curly' },
    version: overrides.version ?? 0,
  }
}

const realLaunchPlacement = async () => ({
  agentRoot: '/tmp/agents/curly',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
  harness: { provider: 'openai' as const, interactive: true },
})

describe('POST /v1/sessions/launch', () => {
  test('launch sources preset, version and phase from the wrkf instance when the task record carries none', async () => {
    let captured:
      | { sessionRef: { scopeRef: string; laneRef: string }; intent: HrcRuntimeIntent }
      | undefined
    await withWiredServer(
      async (fixture) => {
        // Real adapter shape: getTask returns NO preset/version and phase: null.
        const task = await fixture.wrkqStore.taskStore.createTask(
          createRealAdapterTask({
            taskId: 'T-42050',
            projectId: fixture.seed.projectId,
            riskClass: 'medium',
            roleMap: { tester: 'curly' },
          })
        )
        const sessionRef = {
          scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:${task.taskId}:role:tester`,
          laneRef: 'main',
        }

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/launch',
          body: { sessionRef, taskId: task.taskId, role: 'tester' },
        })

        expect(response.status).toBe(200)
        expect(await fixture.json(response)).toEqual({
          runId: 'run-tester-050',
          sessionId: 'session-tester-050',
        })
        expect(captured?.sessionRef).toEqual(sessionRef)
        expect(captured?.intent.placement.correlation?.sessionRef).toEqual(sessionRef)
        expect(captured?.intent.taskContext).toEqual({
          taskId: task.taskId,
          phase: 'green',
          role: 'tester',
          requiredEvidenceKinds: ['qa_bundle'],
          hintsText: expect.stringContaining(
            'Objective: Ship the smallest fix that makes the repro pass.'
          ),
        })
      },
      {
        // Instance carries the workflow facts (flat, templateVersion as a string).
        wrkf: wrkfPortWithInstance({
          templateId: 'code_defect_fastlane',
          templateVersion: '1',
          phase: 'green',
        }),
        runtimeResolver: realLaunchPlacement,
        launchRoleScopedRun: async (input) => {
          captured = input as typeof captured
          return { runId: 'run-tester-050', sessionId: 'session-tester-050' }
        },
      }
    )
  })

  test('launch of a task with no workflow instance is refused 422 workflow_preset_required', async () => {
    let launches = 0
    await withWiredServer(
      async (fixture) => {
        const task = await fixture.wrkqStore.taskStore.createTask(
          createRealAdapterTask({
            taskId: 'T-42051',
            projectId: fixture.seed.projectId,
            roleMap: { tester: 'curly' },
          })
        )

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/launch',
          body: {
            sessionRef: {
              scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:${task.taskId}:role:tester`,
              laneRef: 'main',
            },
            taskId: task.taskId,
            role: 'tester',
          },
        })

        expect(response.status).toBe(422)
        const payload = await fixture.json<{ error: { code: string; message: string } }>(response)
        expect(payload.error.code).toBe('workflow_preset_required')
        expect(payload.error.message).toContain('not pinned to a workflow preset')
        expect(launches).toBe(0)
      },
      {
        // No instance attached: inspect throws "workflow instance not found".
        wrkf: wrkfPortWithInstance(undefined),
        runtimeResolver: realLaunchPlacement,
        launchRoleScopedRun: async () => {
          launches += 1
          return { runId: 'r', sessionId: 's' }
        },
      }
    )
  })

  test('launch with no launcher wired is refused naming the missing launcher', async () => {
    await withWiredServer(
      async (fixture) => {
        const task = await fixture.wrkqStore.taskStore.createTask(
          createTestTask({ taskId: 'T-42002', projectId: fixture.seed.projectId, phase: 'green' })
        )

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/launch',
          body: {
            sessionRef: {
              scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:${task.taskId}:role:tester`,
              laneRef: 'main',
            },
            taskId: task.taskId,
            role: 'tester',
          },
        })

        expect(response.status).toBe(500)
        const payload = await fixture.json<{
          error: { code: string; details?: { cause?: string } }
        }>(response)
        expect(payload.error.code).toBe('internal_error')
        expect(payload.error.details?.cause).toContain('no launcher wired')
      },
      { runtimeResolver: realLaunchPlacement }
    )
  })
})

describe('resolveLaunchIntent env injection', () => {
  test('supplied launch env lands in intent.launch.env alongside the prompt', async () => {
    await withWiredServer(async (fixture) => {
      const deps = resolveAcpServerDeps({
        wrkqStore: fixture.wrkqStore,
        coordStore: fixture.coordStore,
        interfaceStore: fixture.interfaceStore,
        inputAttemptStore: fixture.inputAttemptStore,
        runStore: fixture.runStore,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/pbc-writer',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
        }),
      })

      const intent = await resolveLaunchIntent(
        deps,
        {
          scopeRef: `agent:pbc-writer:project:${fixture.seed.projectId}:task:T-42100:role:agent`,
          laneRef: 'main',
        },
        {
          initialPrompt: 'do the thing',
          env: { WRKF_ACTOR: 'pbc-writer', WRKF_ROLE: 'agent', WRKF_TASK: 'T-42100' },
        }
      )

      expect(intent.launch?.env).toMatchObject({
        WRKF_ACTOR: 'pbc-writer',
        WRKF_ROLE: 'agent',
        WRKF_TASK: 'T-42100',
      })
      expect(intent.initialPrompt).toBe('do the thing')
    })
  })

  test('omits launch.env when no env option is supplied', async () => {
    await withWiredServer(async (fixture) => {
      const deps = resolveAcpServerDeps({
        wrkqStore: fixture.wrkqStore,
        coordStore: fixture.coordStore,
        interfaceStore: fixture.interfaceStore,
        inputAttemptStore: fixture.inputAttemptStore,
        runStore: fixture.runStore,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/pbc-writer',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
        }),
      })

      const intent = await resolveLaunchIntent(deps, {
        scopeRef: `agent:pbc-writer:project:${fixture.seed.projectId}:task:T-42101:role:agent`,
        laneRef: 'main',
      })

      expect(intent.launch?.env).toBeUndefined()
    })
  })
})
