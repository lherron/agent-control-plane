import { describe, expect, test } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import { createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { resolveAcpServerDeps } from '../src/deps.js'
import { launchRoleScopedTaskRun, resolveLaunchIntent } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('launchRoleScopedTaskRun', () => {
  test('computes taskContext and forwards it to launchRoleScopedRun', async () => {
    await withWiredServer(async (fixture) => {
      const task = await fixture.wrkqStore.taskStore.createTask(
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
          bundle: { kind: 'compose', compose: [] },
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
      const task = await fixture.wrkqStore.taskStore.createTask(
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

describe('resolveLaunchIntent env injection', () => {
  test('threads the env option into intent.launch.env, merging nothing else away', async () => {
    await withWiredServer(async (fixture) => {
      const deps = resolveAcpServerDeps({
        wrkqStore: fixture.wrkqStore,
        coordStore: fixture.coordStore,
        interfaceStore: fixture.interfaceStore,
        inputAttemptStore: fixture.inputAttemptStore,
        runStore: fixture.runStore,
        runtimeResolver: async () => ({ agentRoot: '/tmp/agents/pbc-writer' }),
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
        runtimeResolver: async () => ({ agentRoot: '/tmp/agents/pbc-writer' }),
      })

      const intent = await resolveLaunchIntent(deps, {
        scopeRef: `agent:pbc-writer:project:${fixture.seed.projectId}:task:T-42101:role:agent`,
        laneRef: 'main',
      })

      expect(intent.launch?.env).toBeUndefined()
    })
  })
})
