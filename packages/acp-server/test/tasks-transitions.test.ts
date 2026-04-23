import { describe, expect, test } from 'bun:test'

import { createEvidence, createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('GET /v1/tasks/:taskId/transitions', () => {
  test('lists task transition history', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-50001', projectId: fixture.seed.projectId, phase: 'red' })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [
        createEvidence('tdd_green_bundle'),
      ])

      await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'green',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
        },
      })

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/tasks/${task.taskId}/transitions`,
      })
      const payload = await fixture.json<{ transitions: Array<{ to: { phase: string } }> }>(
        response
      )

      expect(response.status).toBe(200)
      expect(payload.transitions).toHaveLength(1)
      expect(payload.transitions[0]?.to.phase).toBe('green')
    })
  })

  test('returns 404 for missing tasks', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/tasks/T-missing/transitions',
      })

      expect(response.status).toBe(404)
    })
  })
})
