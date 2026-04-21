import { describe, expect, test } from 'bun:test'

import { computeTaskContext, getPreset } from 'acp-core'
import type { HrcRuntimeIntent } from 'hrc-core'

import { createEvidence, createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { resolveAcpServerDeps } from '../src/deps.js'
import { launchRoleScopedTaskRun } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('launchRoleScopedTaskRun', () => {
  test('computes taskContext and forwards it to launchRoleScopedRun', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({
          taskId: 'T-42001',
          projectId: fixture.seed.projectId,
          phase: 'green',
          riskClass: 'medium',
        })
      )
      const sessionRef = {
        scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:${task.taskId}:role:tester`,
        laneRef: 'main',
      }
      let captured: { sessionRef: typeof sessionRef; intent: HrcRuntimeIntent } | undefined

      const deps = resolveAcpServerDeps({
        wrkqStore: fixture.wrkqStore,
        coordStore: fixture.coordStore,
        interfaceStore: fixture.interfaceStore,
        inputAttemptStore: fixture.inputAttemptStore,
        runStore: fixture.runStore,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/curly',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          captured = input
          return { runId: 'run-tester-001', sessionId: 'session-tester-001' }
        },
      })

      const result = await launchRoleScopedTaskRun(deps, {
        sessionRef,
        taskId: task.taskId,
        role: 'tester',
      })

      expect(result.runId).toBe('run-tester-001')
      expect(result.sessionId).toBe('session-tester-001')
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
    })
  })

  test('throws a clear error when no launcher is wired', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-42002', projectId: fixture.seed.projectId, phase: 'green' })
      )

      const deps = resolveAcpServerDeps({
        wrkqStore: fixture.wrkqStore,
        coordStore: fixture.coordStore,
        interfaceStore: fixture.interfaceStore,
        inputAttemptStore: fixture.inputAttemptStore,
        runStore: fixture.runStore,
        runtimeResolver: async () => ({ agentRoot: '/tmp/agents/curly' }),
      })

      await expect(
        launchRoleScopedTaskRun(deps, {
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:${task.taskId}:role:tester`,
            laneRef: 'main',
          },
          taskId: task.taskId,
          role: 'tester',
        })
      ).rejects.toThrow('no launcher wired')
    })
  })
})

describe('POST /v1/sessions/launch', () => {
  test('launches a tester run after red -> green and preserves computed taskContext', async () => {
    const capturedLaunches: Array<{
      sessionRef: { scopeRef: string; laneRef: string }
      intent: {
        taskContext?: {
          taskId: string
          phase: string
          role: string
          requiredEvidenceKinds: string[]
          hintsText: string
        }
      }
    }> = []

    await withWiredServer(
      async (fixture) => {
        const task = fixture.wrkqStore.taskRepo.createTask(
          createTestTask({
            taskId: 'T-42003',
            projectId: fixture.seed.projectId,
            phase: 'red',
            riskClass: 'medium',
          })
        )
        fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [
          createEvidence('tdd_green_bundle'),
        ])

        const transitionResponse = await fixture.request({
          method: 'POST',
          path: `/v1/tasks/${task.taskId}/transitions`,
          body: {
            toPhase: 'green',
            actor: { agentId: 'larry', role: 'implementer' },
            expectedVersion: 0,
          },
        })

        expect(transitionResponse.status).toBe(200)

        const launchResponse = await fixture.request({
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
        const payload = await fixture.json<{ runId: string; sessionId: string }>(launchResponse)
        const expectedContext = computeTaskContext({
          preset: getPreset('code_defect_fastlane', 1),
          task: { ...task, phase: 'green' },
          role: 'tester',
        })

        expect(launchResponse.status).toBe(200)
        expect(payload).toEqual({
          runId: 'run-tester-42003',
          sessionId: 'session-tester-42003',
        })
        expect(capturedLaunches).toHaveLength(1)
        expect(capturedLaunches[0]?.intent.taskContext).toEqual({
          taskId: task.taskId,
          phase: expectedContext.phase,
          role: 'tester',
          requiredEvidenceKinds: expectedContext.requiredEvidenceKinds,
          hintsText: expectedContext.hintsText,
        })
      },
      {
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/curly',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          harness: { provider: 'anthropic', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          capturedLaunches.push(input as (typeof capturedLaunches)[number])
          return {
            runId: 'run-tester-42003',
            sessionId: 'session-tester-42003',
          }
        },
      }
    )
  })
})
