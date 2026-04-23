import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('GAP 4: heartbeat explicit target HTTP endpoints', () => {
  test('PUT heartbeat with scopeRef persists target', async () => {
    await withWiredServer(async (fixture) => {
      // Create agent
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'curly',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // PUT heartbeat with target
      const response = await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/curly/heartbeat',
        body: {
          source: 'cli',
          scopeRef: 'agent:curly:project:agent-spaces',
          laneRef: 'main',
        },
      })

      expect(response.status).toBe(200)
      const result = await fixture.json<{
        heartbeat: {
          agentId: string
          targetScopeRef: string
          targetLaneRef: string
        }
      }>(response)
      expect(result.heartbeat.targetScopeRef).toBe('agent:curly:project:agent-spaces')
      expect(result.heartbeat.targetLaneRef).toBe('main')
    })
  })

  test('PUT heartbeat with scopeRef defaults laneRef to main', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'curly',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      const response = await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/curly/heartbeat',
        body: {
          scopeRef: 'agent:curly:project:agent-spaces',
        },
      })

      expect(response.status).toBe(200)
      const result = await fixture.json<{
        heartbeat: { targetScopeRef: string; targetLaneRef: string }
      }>(response)
      expect(result.heartbeat.targetScopeRef).toBe('agent:curly:project:agent-spaces')
      expect(result.heartbeat.targetLaneRef).toBe('main')
    })
  })

  test('POST wake uses persisted heartbeat target', async () => {
    await withWiredServer(async (fixture) => {
      // Create agent + project + membership
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'cody',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'agent-spaces',
          displayName: 'Agent Spaces',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/memberships',
        body: {
          projectId: 'agent-spaces',
          agentId: 'cody',
          role: 'implementer',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Set heartbeat with explicit target
      await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/cody/heartbeat',
        body: {
          scopeRef: 'agent:cody:project:agent-spaces',
          laneRef: 'main',
        },
      })

      // Wake should use persisted target
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents/cody/heartbeat/wake',
        body: {},
      })

      expect(response.status).toBe(202)
      const result = await fixture.json<{
        accepted: boolean
        agentId: string
        projectId: string
      }>(response)
      expect(result.accepted).toBe(true)
      expect(result.agentId).toBe('cody')
      expect(result.projectId).toBe('agent-spaces')
    })
  })

  test('POST wake rejects when no persisted target and no override', async () => {
    await withWiredServer(async (fixture) => {
      // Create agent (with project membership, but no heartbeat target)
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'lonely',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'test-project',
          displayName: 'Test',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/memberships',
        body: {
          projectId: 'test-project',
          agentId: 'lonely',
          role: 'implementer',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Wake without any target — should be rejected (no more membership inference)
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents/lonely/heartbeat/wake',
        body: {},
      })

      expect(response.status).toBe(400)
      const result = await fixture.json<{ error: { code: string; message: string } }>(response)
      expect(result.error.code).toBe('malformed_request')
      expect(result.error.message).toContain('no explicit wake target')
    })
  })

  test('POST wake accepts explicit target override', async () => {
    await withWiredServer(async (fixture) => {
      // Create agent + project
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'cody',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'override-proj',
          displayName: 'Override',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Wake with explicit override — no persisted target needed
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents/cody/heartbeat/wake',
        body: {
          scopeRef: 'agent:cody:project:override-proj',
          laneRef: 'main',
        },
      })

      expect(response.status).toBe(202)
      const result = await fixture.json<{
        accepted: boolean
        projectId: string
      }>(response)
      expect(result.accepted).toBe(true)
      expect(result.projectId).toBe('override-proj')
    })
  })

  test('POST wake override takes precedence over persisted target', async () => {
    await withWiredServer(async (fixture) => {
      // Create agent + two projects
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'cody',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'persisted-proj',
          displayName: 'Persisted',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'override-proj',
          displayName: 'Override',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Set heartbeat with persisted target
      await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/cody/heartbeat',
        body: {
          scopeRef: 'agent:cody:project:persisted-proj',
        },
      })

      // Wake with override — should use override
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents/cody/heartbeat/wake',
        body: {
          scopeRef: 'agent:cody:project:override-proj',
        },
      })

      expect(response.status).toBe(202)
      const result = await fixture.json<{
        projectId: string
      }>(response)
      expect(result.projectId).toBe('override-proj')
    })
  })

  test('POST wake returns 404 for unknown agent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents/ghost/heartbeat/wake',
        body: {},
      })

      expect(response.status).toBe(404)
    })
  })
})
