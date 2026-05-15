import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryAdminStore } from 'acp-admin-store'
import type { Actor, AdminAgent, AdminAgentProfile } from 'acp-core'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpServerDeps } from '../index.js'

const ACTOR = {
  kind: 'agent',
  id: 'smokey',
  displayName: 'Smokey',
} satisfies Actor

const PROFILE = {
  displayColor: '#2A7FFF',
  monogram: 'SMK',
  avatarUrl: 'https://example.test/smokey.png',
  tagline: 'E2E validator',
  role: 'TDD gatekeeper',
  defaultModel: 'gpt-5.2',
  vibe: ['direct', 'careful'],
  specialties: ['smoke tests', 'red green handoffs'],
} satisfies AdminAgentProfile

type CreateAgentWithProfileInput = Parameters<
  ReturnType<typeof createInMemoryAdminStore>['agents']['create']
>[0] & {
  profile?: AdminAgentProfile | null | undefined
}

type PatchAgentWithProfileInput = Parameters<
  ReturnType<typeof createInMemoryAdminStore>['agents']['patch']
>[0] & {
  profile?: AdminAgentProfile | null | undefined
}

type ProfileAgentsStore = Omit<
  ReturnType<typeof createInMemoryAdminStore>['agents'],
  'create' | 'patch'
> & {
  create(input: CreateAgentWithProfileInput): AdminAgent
  patch(input: PatchAgentWithProfileInput): AdminAgent | undefined
}

type AcpServerDepsWithAgentAssets = AcpServerDeps & {
  agentAssetsDir?: string | undefined
}

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function profileAgents(store: ReturnType<typeof createInMemoryAdminStore>): ProfileAgentsStore {
  return store.agents as ProfileAgentsStore
}

function seedAdminStore() {
  const adminStore = createInMemoryAdminStore()
  const agents = profileAgents(adminStore)
  agents.create({
    agentId: 'smokey',
    displayName: 'Smokey',
    status: 'active',
    profile: PROFILE,
    actor: ACTOR,
    now: '2026-05-15T01:10:00.000Z',
  })
  agents.create({
    agentId: 'unset',
    displayName: 'Unset Agent',
    status: 'active',
    actor: ACTOR,
    now: '2026-05-15T01:11:00.000Z',
  })
  return adminStore
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('admin agent profile routes', () => {
  test('GET /v1/admin/agents includes profile only when profile fields are set', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({ method: 'GET', path: '/v1/admin/agents' })

        expect(response.status).toBe(200)
        const body = (await fixture.json<{ agents: AdminAgent[] }>(response)).agents
        expect(body.find((agent) => agent.agentId === 'smokey')?.profile).toEqual(PROFILE)
        expect(body.find((agent) => agent.agentId === 'unset')).not.toHaveProperty('profile')
      },
      { adminStore: seedAdminStore() }
    )
  })

  test('GET /v1/admin/agents/:id includes nested profile and omits it when unset', async () => {
    await withWiredServer(
      async (fixture) => {
        const withProfile = await fixture.request({
          method: 'GET',
          path: '/v1/admin/agents/smokey',
        })
        const unset = await fixture.request({ method: 'GET', path: '/v1/admin/agents/unset' })

        expect(withProfile.status).toBe(200)
        expect((await fixture.json<{ agent: AdminAgent }>(withProfile)).agent.profile).toEqual(
          PROFILE
        )
        expect(unset.status).toBe(200)
        expect((await fixture.json<{ agent: AdminAgent }>(unset)).agent).not.toHaveProperty(
          'profile'
        )
      },
      { adminStore: seedAdminStore() }
    )
  })

  test('PATCH /v1/admin/agents/:id/profile sets fields and preserves omitted fields', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'PATCH',
          path: '/v1/admin/agents/smokey/profile',
          body: {
            tagline: 'Red/green validator',
            vibe: ['precise'],
            actor: { kind: 'agent', id: 'smokey' },
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<{ agent: AdminAgent }>(response)
        expect(body.agent.profile).toEqual({
          ...PROFILE,
          tagline: 'Red/green validator',
          vibe: ['precise'],
        })
      },
      { adminStore: seedAdminStore() }
    )
  })

  test('PATCH /v1/admin/agents/:id/profile clears fields with null', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'PATCH',
          path: '/v1/admin/agents/smokey/profile',
          body: {
            displayColor: null,
            monogram: null,
            vibe: null,
            actor: { kind: 'agent', id: 'smokey' },
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<{ agent: AdminAgent }>(response)
        expect(body.agent.profile).toEqual({
          avatarUrl: PROFILE.avatarUrl,
          tagline: PROFILE.tagline,
          role: PROFILE.role,
          defaultModel: PROFILE.defaultModel,
          specialties: PROFILE.specialties,
        })
      },
      { adminStore: seedAdminStore() }
    )
  })

  test('PATCH /v1/admin/agents/:id/profile rejects invalid profile input', async () => {
    await withWiredServer(
      async (fixture) => {
        const badColor = await fixture.request({
          method: 'PATCH',
          path: '/v1/admin/agents/smokey/profile',
          body: { displayColor: 'blue', actor: { kind: 'agent', id: 'smokey' } },
        })
        const badArray = await fixture.request({
          method: 'PATCH',
          path: '/v1/admin/agents/smokey/profile',
          body: { vibe: ['focused', '   '], actor: { kind: 'agent', id: 'smokey' } },
        })

        expect(badColor.status).toBe(400)
        expect(await readJson(badColor)).toMatchObject({
          error: { code: 'malformed_request', details: { field: 'profile.displayColor' } },
        })
        expect(badArray.status).toBe(400)
        expect(await readJson(badArray)).toMatchObject({
          error: { code: 'malformed_request', details: { field: 'profile.vibe' } },
        })
      },
      { adminStore: seedAdminStore() }
    )
  })

  test('PATCH /v1/admin/agents/:id/profile returns 404 for an unknown agent', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'PATCH',
          path: '/v1/admin/agents/missing/profile',
          body: { tagline: 'Unknown', actor: { kind: 'agent', id: 'smokey' } },
        })

        expect(response.status).toBe(404)
        expect(await readJson(response)).toMatchObject({
          error: { code: 'not_found', details: { agentId: 'missing' } },
        })
      },
      { adminStore: seedAdminStore() }
    )
  })
})

describe('agent pfp asset route', () => {
  test('GET /v1/assets/agents/:agentId/pfp.png serves PNG bytes from configured asset dir', async () => {
    const agentAssetsDir = mkdtempSync(join(tmpdir(), 'acp-agent-assets-'))
    tempDirs.push(agentAssetsDir)
    const pfpDir = join(agentAssetsDir, 'smokey')
    mkdirSync(pfpDir, { recursive: true })
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ])
    writeFileSync(join(pfpDir, 'pfp.png'), pngBytes)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/assets/agents/smokey/pfp.png',
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(Buffer.from(await response.arrayBuffer())).toEqual(pngBytes)
      },
      { agentAssetsDir } satisfies Partial<AcpServerDepsWithAgentAssets>
    )
  })

  test('GET /v1/assets/agents/:agentId/pfp.png returns 404 when the file is missing', async () => {
    const agentAssetsDir = mkdtempSync(join(tmpdir(), 'acp-agent-assets-'))
    tempDirs.push(agentAssetsDir)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/assets/agents/no-avatar/pfp.png',
        })

        expect(response.status).toBe(404)
        expect(await readJson(response)).toMatchObject({
          error: { code: 'not_found', details: { agentId: 'no-avatar' } },
        })
      },
      { agentAssetsDir } satisfies Partial<AcpServerDepsWithAgentAssets>
    )
  })

  test('GET /v1/assets/agents/:agentId/pfp.png rejects path traversal agent ids', async () => {
    const agentAssetsDir = mkdtempSync(join(tmpdir(), 'acp-agent-assets-'))
    tempDirs.push(agentAssetsDir)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/assets/agents/${encodeURIComponent('../smokey')}/pfp.png`,
        })

        expect(response.status).toBe(400)
        expect(await readJson(response)).toMatchObject({
          error: { code: 'malformed_request', details: { field: 'agentId' } },
        })
      },
      { agentAssetsDir } satisfies Partial<AcpServerDepsWithAgentAssets>
    )
  })
})
