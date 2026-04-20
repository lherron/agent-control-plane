import { describe, expect, test } from 'bun:test'

import {
  createEvidence,
  createTestTask,
  createWaiver,
} from '../../acp-core/test/fixtures/in-memory-stores.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/tasks/:taskId/transitions', () => {
  test('applies a valid transition', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40001', projectId: fixture.seed.projectId, phase: 'open' })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [createEvidence('tdd_red_bundle')])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'red',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
        },
      })
      const payload = await fixture.json<{
        task: { phase: string; version: number }
        transition: { to: { phase: string } }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.task.phase).toBe('red')
      expect(payload.task.version).toBe(1)
      expect(payload.transition.to.phase).toBe('red')
    })
  })

  test('returns role_not_allowed', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40002', projectId: fixture.seed.projectId, phase: 'open' })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [createEvidence('tdd_red_bundle')])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'red',
          actor: { agentId: 'curly', role: 'tester' },
          expectedVersion: 0,
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('role_not_allowed')
    })
  })

  test('returns sod_violation', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({
          taskId: 'T-40003',
          projectId: fixture.seed.projectId,
          phase: 'green',
          roleMap: { implementer: 'larry', tester: 'curly', triager: 'tracy' },
        })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [createEvidence('qa_bundle')])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'verified',
          actor: { agentId: 'larry', role: 'tester' },
          expectedVersion: 0,
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('sod_violation')
    })
  })

  test('allows medium-risk verification by an independent tester-role actor', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({
          taskId: 'T-40003B',
          projectId: fixture.seed.projectId,
          phase: 'green',
          roleMap: { implementer: 'larry', tester: 'curly', triager: 'tracy' },
        })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [createEvidence('qa_bundle')])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'verified',
          actor: { agentId: 'mallory', role: 'tester' },
          expectedVersion: 0,
        },
      })
      const payload = await fixture.json<{
        task: { phase: string; version: number }
        transition: { actor: { agentId: string; role: string }; to: { phase: string } }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.task.phase).toBe('verified')
      expect(payload.task.version).toBe(1)
      expect(payload.transition.actor).toEqual({ agentId: 'mallory', role: 'tester' })
      expect(payload.transition.to.phase).toBe('verified')
    })
  })

  test('returns missing_evidence', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40004', projectId: fixture.seed.projectId, phase: 'red' })
      )

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'green',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
        },
      })
      const payload = await fixture.json<{
        error: { code: string; details?: { missingEvidenceKinds?: string[] } }
      }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('missing_evidence')
      expect(payload.error.details?.missingEvidenceKinds).toEqual(['tdd_green_bundle'])
    })
  })

  test('returns no_waiver when waivers are supplied but invalid', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40005', projectId: fixture.seed.projectId, phase: 'red' })
      )

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'green',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
          waivers: [
            createWaiver({
              waiverKind: 'wrong-kind',
              scope: 'red->green',
            }),
          ],
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('no_waiver')
    })
  })

  test('returns version_conflict for stale expectedVersion', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40006', projectId: fixture.seed.projectId, phase: 'red' })
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
          expectedVersion: 3,
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('version_conflict')
    })
  })

  test('returns unknown_transition', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40007', projectId: fixture.seed.projectId, phase: 'open' })
      )

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'verified',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('unknown_transition')
    })
  })

  test('allows verified -> completed without additional evidence', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40007B', projectId: fixture.seed.projectId, phase: 'verified' })
      )

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'completed',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
        },
      })
      const payload = await fixture.json<{
        task: { phase: string; lifecycleState: string; version: number }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.task.phase).toBe('completed')
      expect(payload.task.lifecycleState).toBe('completed')
      expect(payload.task.version).toBe(1)
    })
  })

  test('filters cited evidence by evidenceRefs when provided', async () => {
    await withWiredServer(async (fixture) => {
      const task = fixture.wrkqStore.taskRepo.createTask(
        createTestTask({ taskId: 'T-40008', projectId: fixture.seed.projectId, phase: 'red' })
      )
      fixture.wrkqStore.evidenceRepo.appendEvidence(task.taskId, [
        createEvidence('tdd_green_bundle', 'artifact://green/selected'),
        createEvidence('qa_bundle', 'artifact://qa/other'),
      ])

      const response = await fixture.request({
        method: 'POST',
        path: `/v1/tasks/${task.taskId}/transitions`,
        body: {
          toPhase: 'green',
          actor: { agentId: 'larry', role: 'implementer' },
          expectedVersion: 0,
          evidenceRefs: ['artifact://green/selected'],
        },
      })
      const payload = await fixture.json<{
        transition: { evidenceKinds: string[] }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.transition.evidenceKinds).toEqual(['tdd_green_bundle'])
    })
  })
})
