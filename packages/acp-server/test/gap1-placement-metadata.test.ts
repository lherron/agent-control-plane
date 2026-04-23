import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('GAP 1: placement metadata HTTP endpoints', () => {
  test('POST /v1/admin/agents with homeDir persists and returns it', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'curly',
          displayName: 'Curly',
          homeDir: '/home/curly',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(response.status).toBe(201)
      const result = await fixture.json<{
        agent: { agentId: string; homeDir: string }
      }>(response)
      expect(result.agent.agentId).toBe('curly')
      expect(result.agent.homeDir).toBe('/home/curly')
    })
  })

  test('GET /v1/admin/agents/:agentId returns homeDir', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'curly',
          homeDir: '/home/curly',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      const getResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/agents/curly',
      })
      expect(getResponse.status).toBe(200)
      const result = await fixture.json<{
        agent: { agentId: string; homeDir: string }
      }>(getResponse)
      expect(result.agent.homeDir).toBe('/home/curly')
    })
  })

  test('PATCH /v1/admin/agents/:agentId updates homeDir', async () => {
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

      const patchResponse = await fixture.request({
        method: 'PATCH',
        path: '/v1/admin/agents/curly',
        body: {
          homeDir: '/new/home',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(patchResponse.status).toBe(200)
      const result = await fixture.json<{
        agent: { homeDir: string }
      }>(patchResponse)
      expect(result.agent.homeDir).toBe('/new/home')
    })
  })

  test('POST /v1/admin/projects with rootDir persists and returns it', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'agent-spaces',
          displayName: 'Agent Spaces',
          rootDir: '/Users/dev/agent-spaces',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(response.status).toBe(201)
      const result = await fixture.json<{
        project: { projectId: string; rootDir: string }
      }>(response)
      expect(result.project.projectId).toBe('agent-spaces')
      expect(result.project.rootDir).toBe('/Users/dev/agent-spaces')
    })
  })

  test('GET /v1/admin/projects/:projectId returns rootDir', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'agent-spaces',
          displayName: 'Agent Spaces',
          rootDir: '/Users/dev/agent-spaces',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      const getResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/projects/agent-spaces',
      })
      expect(getResponse.status).toBe(200)
      const result = await fixture.json<{
        project: { rootDir: string }
      }>(getResponse)
      expect(result.project.rootDir).toBe('/Users/dev/agent-spaces')
    })
  })

  test('default-agent rejects agent that is not a project member', async () => {
    await withWiredServer(async (fixture) => {
      // Create project
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'test-proj',
          displayName: 'Test Project',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Create agent (but don't add as member)
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'outsider',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Try to set default agent — should fail
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects/test-proj/default-agent',
        body: {
          agentId: 'outsider',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(response.status).toBe(400)
      const result = await fixture.json<{ error: { code: string; message: string } }>(response)
      expect(result.error.code).toBe('malformed_request')
      expect(result.error.message).toContain('not a member')
    })
  })

  test('default-agent accepts agent that is a project member', async () => {
    await withWiredServer(async (fixture) => {
      // Create project
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'test-proj',
          displayName: 'Test Project',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Create agent
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'member',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Add as member
      await fixture.request({
        method: 'POST',
        path: '/v1/admin/memberships',
        body: {
          projectId: 'test-proj',
          agentId: 'member',
          role: 'implementer',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      // Set default agent — should succeed
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects/test-proj/default-agent',
        body: {
          agentId: 'member',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(response.status).toBe(200)
      const result = await fixture.json<{
        project: { defaultAgentId: string }
      }>(response)
      expect(result.project.defaultAgentId).toBe('member')
    })
  })

  test('runtime/resolve surfaces placement metadata when available', async () => {
    await withWiredServer(
      async (fixture) => {
        // Create agent with homeDir
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/agents',
          body: {
            agentId: 'curly',
            homeDir: '/home/curly',
            status: 'active',
            actor: { kind: 'agent', id: 'operator' },
          },
        })

        // Create project with rootDir
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/projects',
          body: {
            projectId: 'demo',
            displayName: 'Demo',
            rootDir: '/projects/demo',
            actor: { kind: 'agent', id: 'operator' },
          },
        })

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/runtime/resolve',
          body: {
            sessionRef: {
              scopeRef: 'agent:curly:project:demo:task:T-99999:role:implementer',
              laneRef: 'main',
            },
          },
        })

        expect(response.status).toBe(200)
        const result = await fixture.json<{
          placement: {
            agentRoot: string
            homeDir: string
            projectRootDir: string
            delegated: boolean
          }
        }>(response)
        expect(result.placement.homeDir).toBe('/home/curly')
        expect(result.placement.projectRootDir).toBe('/projects/demo')
        expect(result.placement.delegated).toBe(false)
      },
      {
        agentRootResolver: async ({ agentId }) => `/tmp/agents/${agentId}`,
      }
    )
  })

  test('runtime/resolve marks delegated when homeDir or rootDir missing', async () => {
    await withWiredServer(
      async (fixture) => {
        // Create agent WITHOUT homeDir
        await fixture.request({
          method: 'POST',
          path: '/v1/admin/agents',
          body: {
            agentId: 'larry',
            status: 'active',
            actor: { kind: 'agent', id: 'operator' },
          },
        })

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/runtime/resolve',
          body: {
            sessionRef: {
              scopeRef: 'agent:larry:project:unknown:task:T-99999:role:implementer',
              laneRef: 'main',
            },
          },
        })

        expect(response.status).toBe(200)
        const result = await fixture.json<{
          placement: {
            homeDir: null
            projectRootDir: null
            delegated: boolean
          }
        }>(response)
        expect(result.placement.homeDir).toBeNull()
        expect(result.placement.projectRootDir).toBeNull()
        expect(result.placement.delegated).toBe(true)
      },
      {
        agentRootResolver: async ({ agentId }) => `/tmp/agents/${agentId}`,
      }
    )
  })
})
