import { describe, expect, test } from 'bun:test'

import { createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('GET /v1/tasks/:taskId', () => {
  test('returns computed context when a role query is supplied', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(
        createTestTask({
          taskId: 'T-20001',
          projectId: fixture.seed.projectId,
          phase: 'green',
        })
      )

      const response = await fixture.request({
        method: 'GET',
        path: '/v1/tasks/T-20001?role=tester',
      })
      const payload = await fixture.json<{
        context?: { phase: string; requiredEvidenceKinds: string[]; hintsText: string }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.context?.phase).toBe('green')
      expect(payload.context?.requiredEvidenceKinds).toEqual(['qa_bundle'])
      expect(payload.context?.hintsText).toContain('Phase: green')
    })
  })

  test('derives context role from actor header when the task role is unique', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-20002', projectId: fixture.seed.projectId, phase: 'open' })
      )

      const response = await fixture.request({
        method: 'GET',
        path: '/v1/tasks/T-20002',
        headers: { 'x-acp-actor-agent-id': 'larry' },
      })
      const payload = await fixture.json<{
        context?: { requiredEvidenceKinds: string[] }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.context?.requiredEvidenceKinds).toEqual(['tdd_red_bundle'])
    })
  })

  test('omits context when no role can be derived', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-20003', projectId: fixture.seed.projectId })
      )
      fixture.wrkqStore.roleAssignmentRepo.setRoleMap('T-20003', {
        implementer: 'larry',
        owner: 'larry',
      })

      const response = await fixture.request({
        method: 'GET',
        path: '/v1/tasks/T-20003',
        headers: { 'x-acp-actor-agent-id': 'larry' },
      })
      const payload = await fixture.json<{ context?: unknown }>(response)

      expect(response.status).toBe(200)
      expect(payload.context).toBeUndefined()
    })
  })

  test('returns 404 for missing tasks', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/tasks/T-missing',
      })

      expect(response.status).toBe(404)
    })
  })
})
