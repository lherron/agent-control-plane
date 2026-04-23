import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/tasks', () => {
  test('creates a preset-driven task with initial phase and version zero', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          projectId: fixture.seed.projectId,
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          riskClass: 'medium',
          roleMap: { implementer: 'larry', tester: 'curly' },
          actor: { agentId: 'tracy' },
          meta: { intake: 'api' },
        },
      })

      const payload = await fixture.json<{ task: Record<string, unknown> }>(response)

      expect(response.status).toBe(201)
      expect(payload.task['taskId']).toMatch(/^T-/)
      expect(payload.task['phase']).toBe('red')
      expect(payload.task['lifecycleState']).toBe('open')
      expect(payload.task['version']).toBe(0)
      expect(payload.task['workflowPreset']).toBe('code_defect_fastlane')
      expect(payload.task['presetVersion']).toBe(1)
      expect(payload.task['meta']).toEqual({ intake: 'api' })
    })
  })

  test('accepts actor from request header when body actor is omitted', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        headers: { 'x-acp-actor-agent-id': 'tracy' },
        body: {
          projectId: fixture.seed.projectId,
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          roleMap: { implementer: 'larry' },
        },
      })

      expect(response.status).toBe(201)
    })
  })

  test('allows medium-risk fastlane tasks without a tester assignment', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          projectId: fixture.seed.projectId,
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          riskClass: 'medium',
          roleMap: { implementer: 'larry' },
          actor: { agentId: 'tracy' },
        },
      })
      const payload = await fixture.json<{ task: Record<string, unknown> }>(response)

      expect(response.status).toBe(201)
      expect(payload.task['riskClass']).toBe('medium')
      expect(payload.task['roleMap']).toEqual({ implementer: 'larry' })
    })
  })

  test('creates a task without workflowPreset — phase is null', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          projectId: fixture.seed.projectId,
          roleMap: { implementer: 'larry' },
          actor: { agentId: 'tracy' },
        },
      })

      const payload = await fixture.json<{ task: Record<string, unknown> }>(response)

      expect(response.status).toBe(201)
      expect(payload.task['phase']).toBeNull()
      expect(payload.task['lifecycleState']).toBe('open')
      expect(payload.task['workflowPreset']).toBeUndefined()
    })
  })

  test('rejects phase when workflowPreset is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          projectId: fixture.seed.projectId,
          phase: 'red',
          roleMap: { implementer: 'larry' },
          actor: { agentId: 'tracy' },
        },
      })

      const payload = await fixture.json<{ error: { code: string } }>(response)
      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('phase_requires_preset')
    })
  })

  test('rejects malformed bodies', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/tasks',
        body: {
          workflowPreset: 'code_defect_fastlane',
          presetVersion: 1,
          roleMap: { implementer: 'larry' },
          actor: { agentId: 'tracy' },
        },
      })

      const payload = await fixture.json<{ error: { code: string } }>(response)
      expect(response.status).toBe(400)
      expect(payload.error.code).toBe('malformed_request')
    })
  })
})
