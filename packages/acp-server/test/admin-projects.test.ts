import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin projects endpoints', () => {
  test('creates, lists, fetches, and sets a default agent', async () => {
    await withWiredServer(async (fixture) => {
      const agentResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'smokey',
          displayName: 'Smokey',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      expect(agentResponse.status).toBe(201)

      const createResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'agent-spaces',
          displayName: 'Agent Spaces',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(createResponse.status).toBe(201)
      expect(
        await fixture.json<{ project: { projectId: string; displayName: string } }>(createResponse)
      ).toEqual({
        project: expect.objectContaining({
          projectId: 'agent-spaces',
          displayName: 'Agent Spaces',
        }),
      })

      const listResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/projects',
      })
      expect(listResponse.status).toBe(200)

      const getResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/projects/agent-spaces',
      })
      expect(getResponse.status).toBe(200)

      const setDefaultAgentResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects/agent-spaces/default-agent',
        body: {
          agentId: 'smokey',
          actor: { kind: 'human', id: 'operator' },
        },
      })

      expect(setDefaultAgentResponse.status).toBe(200)
      expect(
        await fixture.json<{ project: { defaultAgentId?: string | undefined } }>(
          setDefaultAgentResponse
        )
      ).toEqual({
        project: expect.objectContaining({ defaultAgentId: 'smokey' }),
      })
    })
  })

  test('returns 404 when default-agent references a missing agent or project', async () => {
    await withWiredServer(async (fixture) => {
      const missingProject = await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects/missing/default-agent',
        body: {
          agentId: 'ghost',
          actor: { kind: 'human', id: 'operator' },
        },
      })

      expect(missingProject.status).toBe(404)
      expect(await fixture.json<{ error: { code: string } }>(missingProject)).toEqual({
        error: expect.objectContaining({ code: 'not_found' }),
      })
    })
  })
})
