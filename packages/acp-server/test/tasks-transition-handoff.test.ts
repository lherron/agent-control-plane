import { describe, expect, test } from 'bun:test'

import { listEvents, listOpenHandoffs, listPendingWakes } from 'coordination-substrate'

import { createEvidence, createTestTask } from '../../acp-core/test/fixtures/in-memory-stores.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/tasks/:taskId/transitions handoff composition', () => {
  test('writes one event, handoff, and wake after red -> green', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-41001', projectId: fixture.seed.projectId, phase: 'red' })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [
        createEvidence('tdd_green_bundle'),
      ])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'green',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
          idempotencyKey: 'handoff-1',
        },
      })
      const payload = await fixture.json<{
        handoff?: { taskId?: string }
        wake?: { state: string }
      }>(response)
      const events = listEvents(fixture.coordStore, {
        projectId: fixture.seed.projectId,
        taskId: task.taskId,
      })
      const handoffs = listOpenHandoffs(fixture.coordStore, {
        projectId: fixture.seed.projectId,
        taskId: task.taskId,
      })
      const wakes = listPendingWakes(fixture.coordStore, {
        projectId: fixture.seed.projectId,
        sessionRef: {
          scopeRef: `agent:curly:project:${fixture.seed.projectId}:task:${task.taskId}:role:tester`,
          laneRef: 'main',
        },
      })

      expect(response.status).toBe(200)
      expect(payload.handoff?.taskId).toBe(task.taskId)
      expect(payload.wake?.state).toBe('queued')
      expect(events).toHaveLength(1)
      expect(events[0]?.kind).toBe('handoff.declared')
      expect(handoffs).toHaveLength(1)
      expect(wakes).toHaveLength(1)
    })
  })

  test('does not auto-handoff low-risk red -> green transitions', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({
          taskId: 'T-41002',
          projectId: fixture.seed.projectId,
          phase: 'red',
          riskClass: 'low',
        })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [
        createEvidence('tdd_green_bundle'),
      ])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'green',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
        },
      })

      expect(response.status).toBe(200)
      expect(
        listEvents(fixture.coordStore, { projectId: fixture.seed.projectId, taskId: task.taskId })
      ).toHaveLength(0)
    })
  })

  test('returns 422 when requestHandoff is forced but no tester exists', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({
          taskId: 'T-41003',
          projectId: fixture.seed.projectId,
          phase: 'red',
          roleMap: { implementer: 'larry' },
        })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [
        createEvidence('tdd_green_bundle'),
      ])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'green',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
          requestHandoff: true,
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('handoff_target_missing')
    })
  })
})
