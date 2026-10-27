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
      expect(
        (await fixture.json<{ projects: Array<{ projectId: string }> }>(listResponse)).projects
      ).toContainEqual(expect.objectContaining({ projectId: 'agent-spaces' }))

      const getResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/projects/agent-spaces',
      })
      expect(getResponse.status).toBe(200)
      expect(
        (await fixture.json<{ project: { projectId: string } }>(getResponse)).project.projectId
      ).toBe('agent-spaces')

      // Add agent as project member before setting as default
      const membershipResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/memberships',
        body: {
          projectId: 'agent-spaces',
          agentId: 'smokey',
          role: 'coordinator',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      expect(membershipResponse.status).toBe(201)

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

  test('default-agent on a missing project or a missing agent returns 404 naming the missing resource', async () => {
    const rows = [
      {
        name: 'missing project',
        projectId: 'missing',
        agentId: 'ghost',
        expected: { message: 'project not found', details: { projectId: 'missing' } },
      },
      {
        name: 'missing agent',
        projectId: 'agent-spaces',
        agentId: 'ghost',
        expected: { message: 'agent not found', details: { agentId: 'ghost' } },
      },
    ]

    for (const row of rows) {
      await withWiredServer(async (fixture) => {
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/projects',
          body: {
            projectId: 'agent-spaces',
            displayName: 'Agent Spaces',
            actor: { kind: 'agent', id: 'operator' },
          },
        })

        const response = await fixture.request({
          method: 'POST',
          path: `/v1/admin/projects/${row.projectId}/default-agent`,
          body: {
            agentId: row.agentId,
            actor: { kind: 'human', id: 'operator' },
          },
        })

        expect(response.status, row.name).toBe(404)
        expect(await fixture.json<{ error: Record<string, unknown> }>(response), row.name).toEqual({
          error: expect.objectContaining({ code: 'not_found', ...row.expected }),
        })
      })
    }
  })
})
