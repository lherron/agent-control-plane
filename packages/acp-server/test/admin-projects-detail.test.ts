import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin project detail endpoint', () => {
  test('GET /v1/admin/projects/:projectId/detail returns enriched project state', async () => {
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
            method: 'POST',
            path: '/v1/interface/bindings',
            body: {
              gatewayId: 'discord_prod',
              conversationRef: 'channel:123',
              projectId: 'agent-spaces',
              sessionRef: {
                scopeRef: 'agent:larry:project:agent-spaces',
                laneRef: 'main',
              },
            },
          })
          await fixture.request({
            method: 'POST',
            path: '/v1/admin/system-events',
            body: {
              projectId: 'agent-spaces',
              kind: 'project.created',
              payload: { source: 'test' },
              occurredAt: '2026-05-11T00:00:00.000Z',
            },
          })

          jobsStore.createJob({
            projectId: 'agent-spaces',
            agentId: 'larry',
            scopeRef: 'agent:larry:project:agent-spaces',
            laneRef: 'main',
            schedule: { cron: '*/5 * * * *' },
            input: { content: 'inspect project' },
          })

          const response = await fixture.request({
            method: 'GET',
            path: '/v1/admin/projects/agent-spaces/detail',
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{
            project: { projectId: string; defaultAgentId?: string }
            defaultAgent: { agentId: string }
            memberships: Array<{ agentId: string; agent?: { agentId: string } }>
            jobs: Array<{ summary: { kind: string; flowStepCount: number } }>
            interfaceBindings: Array<{ gatewayId: string }>
            recentSystemEvents: Array<{ kind: string }>
            provenance: Array<{ source: string; available: boolean }>
          }>(response)

          expect(payload.project).toEqual(
            expect.objectContaining({ projectId: 'agent-spaces', defaultAgentId: 'larry' })
          )
          expect(payload.defaultAgent.agentId).toBe('larry')
          expect(payload.memberships).toEqual([
            expect.objectContaining({
              agentId: 'larry',
              agent: expect.objectContaining({ agentId: 'larry' }),
            }),
          ])
          expect(payload.jobs).toEqual([
            expect.objectContaining({
              summary: expect.objectContaining({ kind: 'input', flowStepCount: 0 }),
            }),
          ])
          expect(payload.interfaceBindings).toEqual([
            expect.objectContaining({ gatewayId: 'discord_prod' }),
          ])
          expect(payload.recentSystemEvents).toEqual([
            expect.objectContaining({ kind: 'project.created' }),
          ])
          expect(payload.provenance).toContainEqual(
            expect.objectContaining({ source: 'jobs_store.jobs', available: true })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })
})
