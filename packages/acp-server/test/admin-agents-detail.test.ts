import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin agent detail endpoint', () => {
  test('GET /v1/admin/agents/:agentId/detail returns memberships jobs heartbeat and targets', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          await fixture.request({
            method: 'POST',
            path: '/v1/admin/agents',
            body: {
              agentId: 'larry',
              displayName: 'Larry',
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
              agentId: 'larry',
              role: 'implementer',
              actor: { kind: 'agent', id: 'operator' },
            },
          })
          await fixture.request({
            method: 'POST',
            path: '/v1/admin/projects/agent-spaces/default-agent',
            body: {
              agentId: 'larry',
              actor: { kind: 'agent', id: 'operator' },
            },
          })
          await fixture.request({
            method: 'PUT',
            path: '/v1/admin/agents/larry/heartbeat',
            body: {
              source: 'test',
              scopeRef: 'agent:larry:project:agent-spaces:task:T-01412',
              laneRef: 'main',
            },
          })

          jobsStore.createJob({
            projectId: 'agent-spaces',
            agentId: 'larry',
            scopeRef: 'agent:larry:project:agent-spaces:task:T-01412',
            laneRef: 'main',
            schedule: { cron: '*/10 * * * *' },
            input: { content: 'inspect agent' },
          })

          const response = await fixture.request({
            method: 'GET',
            path: '/v1/admin/agents/larry/detail',
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{
            agent: { agentId: string }
            memberships: Array<{
              projectId: string
              project?: { projectId: string }
              isDefaultAgent: boolean
            }>
            jobs: Array<{ summary: { kind: string; projectId: string } }>
            heartbeat: { source: string; targetScopeRef: string }
            scopeTargets: Array<{ scopeRef: string; laneRef: string; source: string }>
            provenance: Array<{ source: string; available: boolean }>
          }>(response)

          expect(payload.agent.agentId).toBe('larry')
          expect(payload.memberships).toEqual([
            expect.objectContaining({
              projectId: 'agent-spaces',
              project: expect.objectContaining({ projectId: 'agent-spaces' }),
              isDefaultAgent: true,
            }),
          ])
          expect(payload.jobs).toEqual([
            expect.objectContaining({
              summary: expect.objectContaining({ kind: 'input', projectId: 'agent-spaces' }),
            }),
          ])
          expect(payload.heartbeat).toEqual(
            expect.objectContaining({
              source: 'test',
              targetScopeRef: 'agent:larry:project:agent-spaces:task:T-01412',
            })
          )
          expect(payload.scopeTargets).toContainEqual(
            expect.objectContaining({
              scopeRef: 'agent:larry:project:agent-spaces',
              laneRef: 'main',
              source: 'membership',
            })
          )
          expect(payload.scopeTargets).toContainEqual(
            expect.objectContaining({
              scopeRef: 'agent:larry:project:agent-spaces:task:T-01412',
              laneRef: 'main',
              source: 'job',
            })
          )
          expect(payload.provenance).toContainEqual(
            expect.objectContaining({ source: 'admin_store.agent_heartbeats', available: true })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })
})
