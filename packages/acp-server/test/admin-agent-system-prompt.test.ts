import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import type { Actor } from 'acp-core'

import { withWiredServer } from './fixtures/wired-server.js'

const ACTOR = { kind: 'agent', id: 'operator' } satisfies Actor

function seedStores() {
  const adminStore = createInMemoryAdminStore()
  adminStore.agents.create({
    agentId: 'larry',
    displayName: 'Larry',
    homeDir: '/agents/larry',
    status: 'active',
    actor: ACTOR,
    now: '2026-05-15T00:00:00.000Z',
  })
  adminStore.projects.create({
    projectId: 'agent-spaces',
    displayName: 'Agent Spaces',
    homeDir: '/projects/agent-spaces',
    actor: ACTOR,
    now: '2026-05-15T00:00:00.000Z',
  })
  return adminStore
}

const seenPlacements: unknown[] = []
const seenPreviews: unknown[] = []

const daemonDoubles = {
  placementFetch: async (input: unknown) => {
    seenPlacements.push(input)
    return {
      agentRoot: '/agents/larry',
      projectRoot: '/projects/agent-spaces',
      cwd: '/projects/agent-spaces',
      bundle: {
        kind: 'agent-project',
        agentName: 'larry',
        projectRoot: '/projects/agent-spaces',
      },
      harness: { provider: 'openai', interactive: true },
      agentSources: { agentsRoot: '/agents', aspHome: '/asp-home' },
    }
  },
  runPreviewFetch: async (input: unknown) => {
    seenPreviews.push(input)
    return {
      systemPrompt: 'Agent larry on agent-spaces\nProject docs',
      systemPromptMode: 'append' as const,
      primingPrompt: 'You are larry',
      reminderContent: 'Stay focused',
      promptSectionSizes: ['prompt.identity=24', 'prompt.project-readme=12'],
      reminderSectionSizes: ['reminder.note=13'],
      totalContextChars: 49,
      nearMaxChars: false,
      warnings: [],
    }
  },
}

describe('admin agent system prompt endpoint', () => {
  test('GET /v1/admin/agents/:agentId/system-prompt returns the daemon-compiled prompt', async () => {
    seenPlacements.length = 0
    seenPreviews.length = 0
    const adminStore = seedStores()
    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: '/v1/admin/agents/larry/system-prompt?runMode=query&projectId=agent-spaces',
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{
            systemPrompt: {
              agentRoot: string
              agentsRoot: string
              agentName: string
              runMode: string
              projectRoot: string
              projectId: string
              template: { kind: string; mode: string }
              prompt: { content: string; mode: string; totalChars: number }
              reminder: { content: string; totalChars: number }
              diagnostics: {
                prompt: { sectionSizes: string[]; totalChars: number }
                totalChars: number
                nearMaxChars: boolean
              }
            }
            provenance: Array<{ source: string; available: boolean }>
          }>(response)

          expect(payload.systemPrompt.agentRoot).toBe('/agents/larry')
          expect(payload.systemPrompt.agentsRoot).toBe('/agents')
          expect(payload.systemPrompt.agentName).toBe('larry')
          expect(payload.systemPrompt.runMode).toBe('query')
          expect(payload.systemPrompt.projectRoot).toBe('/projects/agent-spaces')
          expect(payload.systemPrompt.template).toEqual({ kind: 'daemon', mode: 'append' })
          expect(payload.systemPrompt.prompt.content).toContain('Agent larry on agent-spaces')
          expect(payload.systemPrompt.reminder.content).toBe('Stay focused')
          expect(payload.systemPrompt.diagnostics.prompt.sectionSizes).toEqual([
            'prompt.identity=24',
            'prompt.project-readme=12',
          ])
          expect(payload.provenance.find((entry) => entry.source === 'hrc.previews.run')).toEqual({
            source: 'hrc.previews.run',
            available: true,
          })
          expect(seenPlacements).toEqual([
            { agentId: 'larry', projectId: 'agent-spaces', runMode: 'query' },
          ])
          expect(seenPreviews).toHaveLength(1)
        },
        { adminStore, ...daemonDoubles }
      )
    } finally {
      adminStore.close()
    }
  })

  test('returns null when the daemon reports no system prompt', async () => {
    const adminStore = seedStores()
    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: '/v1/admin/agents/larry/system-prompt',
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{ systemPrompt: null }>(response)
          expect(payload.systemPrompt).toBeNull()
        },
        {
          adminStore,
          ...daemonDoubles,
          runPreviewFetch: async (input: unknown) => {
            seenPreviews.push(input)
            return {
              ...(await daemonDoubles.runPreviewFetch(input)),
              systemPrompt: null,
            }
          },
        }
      )
    } finally {
      adminStore.close()
    }
  })

  test('rejects an unknown runMode before touching the daemon', async () => {
    const adminStore = seedStores()
    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: '/v1/admin/agents/larry/system-prompt?runMode=nope',
          })
          expect(response.status).toBe(400)
        },
        { adminStore, ...daemonDoubles }
      )
    } finally {
      adminStore.close()
    }
  })
})
