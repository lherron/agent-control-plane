import { describe, expect, test } from 'bun:test'

import type { Task } from 'acp-core'

import { withWiredServer } from './fixtures/wired-server.js'

function createBareWrkqBugTask(projectId: string, taskId = 'T-61001'): Task {
  return {
    taskId,
    projectId,
    kind: 'bug',
    lifecycleState: 'open',
    phase: '',
    roleMap: {},
    version: 0,
  }
}

describe('POST /v1/tasks/:taskId/promote', () => {
  test('promotes a bare wrkq bug task, writes roles, and logs a transition', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(createBareWrkqBugTask(fixture.seed.projectId))

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-61001/promote',
        body: {
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          riskClass: 'medium',
          roleMap: { triager: 'tracy', implementer: 'larry', tester: 'curly' },
          actor: { agentId: 'tracy' },
        },
      })
      const payload = await fixture.json<{
        task: Task
        transition: {
          actor: { agentId: string; role: string }
          from: { phase: string }
          to: { phase: string }
          expectedVersion: number
          nextVersion: number
        }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.task).toMatchObject({
        taskId: 'T-61001',
        kind: 'bug',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        phase: 'open',
        riskClass: 'medium',
        version: 1,
        roleMap: { triager: 'tracy', implementer: 'larry', tester: 'curly' },
        meta: { acp: { promoted: true, fromKind: 'bug' } },
      })
      expect(payload.transition).toMatchObject({
        actor: { agentId: 'tracy', role: 'triager' },
        from: { phase: '' },
        to: { phase: 'open' },
        expectedVersion: 0,
        nextVersion: 1,
      })
      expect(fixture.wrkqStore.roleAssignmentRepo.getRoleMap('T-61001')).toEqual({
        triager: 'tracy',
        implementer: 'larry',
        tester: 'curly',
      })
      expect(fixture.wrkqStore.transitionLogRepo.listTransitions('T-61001')).toMatchObject([
        {
          taskId: 'T-61001',
          from: { phase: '' },
          to: { phase: 'open' },
          actor: { agentId: 'tracy', role: 'triager' },
          expectedVersion: 0,
          nextVersion: 1,
        },
      ])
    })
  })

  test('returns 404 for missing tasks', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-missing/promote',
        body: {
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          riskClass: 'medium',
          roleMap: { implementer: 'larry' },
          actor: { agentId: 'tracy' },
        },
      })

      expect(response.status).toBe(404)
    })
  })

  test('returns 409 when the task is already preset-driven', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask({
        ...createBareWrkqBugTask(fixture.seed.projectId, 'T-61002'),
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        phase: 'open',
        riskClass: 'medium',
        roleMap: { implementer: 'larry' },
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-61002/promote',
        body: {
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          riskClass: 'medium',
          roleMap: { implementer: 'larry' },
          actor: { agentId: 'tracy' },
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(409)
      expect(payload.error.code).toBe('already_preset_driven')
    })
  })

  test('returns 422 for unknown presets', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(
        createBareWrkqBugTask(fixture.seed.projectId, 'T-61003')
      )

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-61003/promote',
        body: {
          workflowPreset: 'missing_preset',
          presetVersion: 99,
          riskClass: 'medium',
          roleMap: { implementer: 'larry' },
          actor: { agentId: 'tracy' },
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('unknown_preset')
    })
  })

  test('accepts actor.role and initialPhase overrides', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(
        createBareWrkqBugTask(fixture.seed.projectId, 'T-61004')
      )

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-61004/promote',
        body: {
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          riskClass: 'medium',
          initialPhase: 'red',
          roleMap: { implementer: 'larry', tester: 'curly' },
          actor: { agentId: 'larry', role: 'implementer' },
        },
      })
      const payload = await fixture.json<{
        task: { phase: string }
        transition: { actor: { role: string }; to: { phase: string } }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.task.phase).toBe('red')
      expect(payload.transition.actor.role).toBe('implementer')
      expect(payload.transition.to.phase).toBe('red')
    })
  })
})
