import { describe, expect, test } from 'bun:test'

import { createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/tasks/:taskId/evidence', () => {
  test('attaches evidence and returns 204', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-30001', projectId: fixture.seed.projectId })
      )

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-30001/evidence',
        body: {
          actor: { agentId: 'larry' },
          evidence: [{ kind: 'tdd_red_bundle', ref: 'artifact://red/1' }],
        },
      })

      expect(response.status).toBe(204)
      expect(fixture.wrkqStore.evidenceRepo.listEvidence('T-30001')).toHaveLength(1)
    })
  })

  test('defaults evidence.producedBy.agentId from request actor', async () => {
    await withWiredServer(async (fixture) => {
      fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-30002', projectId: fixture.seed.projectId })
      )

      await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-30002/evidence',
        headers: { 'x-acp-actor-agent-id': 'curly' },
        body: {
          evidence: [{ kind: 'qa_bundle', ref: 'artifact://qa/1' }],
        },
      })

      const storedEvidence = fixture.wrkqStore.evidenceRepo.listEvidence('T-30002')
      expect(storedEvidence[0]?.producedBy?.agentId).toBe('curly')
    })
  })

  test('returns 404 for missing tasks', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks/T-missing/evidence',
        body: {
          actor: { agentId: 'larry' },
          evidence: [{ kind: 'qa_bundle', ref: 'artifact://qa/2' }],
        },
      })

      expect(response.status).toBe(404)
    })
  })
})
