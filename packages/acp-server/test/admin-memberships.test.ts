import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin memberships endpoints', () => {
  test('creates memberships and lists them by project', async () => {
    await withWiredServer(async (fixture) => {
      expect(
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/agents',
          body: {
            agentId: 'smokey',
            displayName: 'Smokey',
            status: 'active',
            actor: { kind: 'agent', id: 'operator' },
          },
        })
      ).toHaveProperty('status', 201)

      expect(
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/projects',
          body: {
            projectId: 'agent-spaces',
            displayName: 'Agent Spaces',
            actor: { kind: 'agent', id: 'operator' },
          },
        })
      ).toHaveProperty('status', 201)

      const createResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/memberships',
        body: {
          projectId: 'agent-spaces',
          agentId: 'smokey',
          role: 'tester',
          actor: { kind: 'human', id: 'operator' },
        },
      })

      expect(createResponse.status).toBe(201)
      expect(
        await fixture.json<{ membership: { projectId: string; agentId: string; role: string } }>(
          createResponse
        )
      ).toEqual({
        membership: expect.objectContaining({
          projectId: 'agent-spaces',
          agentId: 'smokey',
          role: 'tester',
        }),
      })

      const listResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/projects/agent-spaces/memberships',
      })

      expect(listResponse.status).toBe(200)
      expect(
        await fixture.json<{ memberships: Array<{ agentId: string; role: string }> }>(listResponse)
      ).toEqual({
        memberships: [expect.objectContaining({ agentId: 'smokey', role: 'tester' })],
      })

      const adminListResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/memberships?projectId=agent-spaces',
      })

      expect(adminListResponse.status).toBe(200)
      expect(
        await fixture.json<{ memberships: Array<{ agentId: string; role: string }> }>(
          adminListResponse
        )
      ).toEqual({
        memberships: [expect.objectContaining({ agentId: 'smokey', role: 'tester' })],
      })
    })
  })

  test('returns 404 when creating a membership for a missing project or agent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/memberships',
        body: {
          projectId: 'missing-project',
          agentId: 'missing-agent',
          role: 'observer',
          actor: { kind: 'human', id: 'operator' },
        },
      })

      expect(response.status).toBe(404)
      expect(await fixture.json<{ error: { code: string } }>(response)).toEqual({
        error: expect.objectContaining({ code: 'not_found' }),
      })
    })
  })

  test('returns 400 when GET /v1/admin/memberships omits projectId', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/admin/memberships',
      })

      expect(response.status).toBe(400)
      expect(
        await fixture.json<{ error: { code: string; details?: { field?: string } } }>(response)
      ).toEqual({
        error: expect.objectContaining({
          code: 'malformed_request',
          details: expect.objectContaining({ field: 'projectId' }),
        }),
      })
    })
  })
})
