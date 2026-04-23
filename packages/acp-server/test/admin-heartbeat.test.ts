import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin heartbeat endpoints', () => {
  test('PUT /v1/admin/agents/:agentId/heartbeat upserts heartbeat', async () => {
    await withWiredServer(async (fixture) => {
      // First create the agent
      const createAgent = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'clod',
          displayName: 'Clod',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      expect(createAgent.status).toBe(201)

      // PUT heartbeat
      const heartbeatResponse = await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/clod/heartbeat',
        body: {
          source: 'cli-test',
          note: 'checking in',
        },
      })

      expect(heartbeatResponse.status).toBe(200)
      const result = await fixture.json<{
        heartbeat: { agentId: string; source: string; lastNote: string; status: string }
      }>(heartbeatResponse)
      expect(result.heartbeat.agentId).toBe('clod')
      expect(result.heartbeat.source).toBe('cli-test')
      expect(result.heartbeat.lastNote).toBe('checking in')
      expect(result.heartbeat.status).toBe('alive')
    })
  })

  test('PUT heartbeat updates on subsequent calls', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'larry',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // First heartbeat
      await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/larry/heartbeat',
        body: { source: 'first' },
      })

      // Second heartbeat
      const response = await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/larry/heartbeat',
        body: { source: 'second', note: 'updated' },
      })

      expect(response.status).toBe(200)
      const result = await fixture.json<{
        heartbeat: { source: string; lastNote: string; status: string }
      }>(response)
      expect(result.heartbeat.source).toBe('second')
      expect(result.heartbeat.lastNote).toBe('updated')
      expect(result.heartbeat.status).toBe('alive')
    })
  })

  test('PUT heartbeat returns 404 for unknown agent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/nonexistent/heartbeat',
        body: { source: 'test' },
      })

      expect(response.status).toBe(404)
    })
  })

  test('PUT heartbeat with minimal body (no source/note)', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'minimal',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      const response = await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/minimal/heartbeat',
        body: {},
      })

      expect(response.status).toBe(200)
      const result = await fixture.json<{
        heartbeat: { agentId: string; status: string }
      }>(response)
      expect(result.heartbeat.agentId).toBe('minimal')
      expect(result.heartbeat.status).toBe('alive')
    })
  })

  test('POST /v1/admin/agents/:agentId/heartbeat/wake returns 404 for unknown agent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents/ghost/heartbeat/wake',
        body: {},
      })

      expect(response.status).toBe(404)
    })
  })

  test('POST wake returns 400 when agent has no explicit target', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'lonely',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents/lonely/heartbeat/wake',
        body: {},
      })

      expect(response.status).toBe(400)
      const result = await fixture.json<{ error: { code: string } }>(response)
      expect(result.error.code).toBe('malformed_request')
    })
  })

  test('POST wake returns 202 with wake details when agent has persisted target', async () => {
    await withWiredServer(async (fixture) => {
      // Create agent, project, and membership
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

      // Set heartbeat with explicit target (required now — no more membership inference)
      await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/cody/heartbeat',
        body: {
          scopeRef: 'agent:cody:project:agent-spaces',
          laneRef: 'main',
        },
      })

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
        wakeId: string
      }>(response)
      expect(result.accepted).toBe(true)
      expect(result.agentId).toBe('cody')
      expect(result.projectId).toBe('agent-spaces')
      expect(result.wakeId).toBeDefined()
    })
  })
})
