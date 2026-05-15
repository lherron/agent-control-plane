import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import type { Actor, AdminAgent, AdminAgentProfile } from 'acp-core'

import {
  type AdminStore,
  SqliteDatabase,
  adminStoreMigrations,
  createInMemoryAdminStore,
  openSqliteAdminStore,
} from '../index.js'

const ACTOR = {
  kind: 'agent',
  id: 'smokey',
  displayName: 'Smokey',
} satisfies Actor

type CreateAgentWithProfileInput = Parameters<AdminStore['agents']['create']>[0] & {
  profile?: AdminAgentProfile | null | undefined
}

type PatchAgentWithProfileInput = Parameters<AdminStore['agents']['patch']>[0] & {
  profile?: AdminAgentProfile | null | undefined
}

type ProfileAgentsStore = Omit<AdminStore['agents'], 'create' | 'patch'> & {
  create(input: CreateAgentWithProfileInput): AdminAgent
  patch(input: PatchAgentWithProfileInput): AdminAgent | undefined
}

function profileAgents(store: AdminStore): ProfileAgentsStore {
  return store.agents as ProfileAgentsStore
}

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'acp-agent-profile-'))
  try {
    return fn(join(dir, 'admin.db'))
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

function seedPre005Agent(dbPath: string): void {
  const sqlite = new SqliteDatabase(dbPath)
  try {
    sqlite.exec('PRAGMA foreign_keys = ON;')
    sqlite.exec(`
      CREATE TABLE acp_admin_store_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `)
    for (const migration of adminStoreMigrations.filter(
      (item) => item.id !== '005_agent_profile'
    )) {
      sqlite.exec(migration.sql)
      sqlite
        .prepare('INSERT INTO acp_admin_store_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, '2026-05-15T01:00:00.000Z')
    }

    sqlite
      .prepare(
        `INSERT INTO agents (
          agent_id,
          display_name,
          home_dir,
          status,
          created_at,
          updated_at,
          actor_stamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'legacy',
        'Legacy Agent',
        '/agents/legacy',
        'active',
        '2026-05-15T01:00:00.000Z',
        '2026-05-15T01:00:00.000Z',
        JSON.stringify({ createdBy: ACTOR, updatedBy: ACTOR })
      )
  } finally {
    sqlite.close()
  }
}

describe('agent profile store contract', () => {
  test('migration 005 preserves pre-profile agents and omits empty profile', () => {
    withTempDb((dbPath) => {
      seedPre005Agent(dbPath)

      const store = openSqliteAdminStore({ dbPath })
      try {
        expect(store.migrations.applied).toContain('005_agent_profile')
        expect(store.agents.get('legacy')).toEqual({
          agentId: 'legacy',
          displayName: 'Legacy Agent',
          homeDir: '/agents/legacy',
          status: 'active',
          createdAt: '2026-05-15T01:00:00.000Z',
          updatedAt: '2026-05-15T01:00:00.000Z',
          createdBy: ACTOR,
          updatedBy: ACTOR,
        })
        expect(store.agents.get('legacy')?.profile).toBeUndefined()
      } finally {
        store.close()
      }
    })
  })

  test('profile scalar fields and JSON arrays round-trip through create, get, and list', () => {
    const store = createInMemoryAdminStore()
    try {
      const agents = profileAgents(store)
      const profile = {
        displayColor: '#2A7FFF',
        monogram: 'SMK',
        avatarUrl: 'https://example.test/smokey.png',
        tagline: 'E2E validator',
        role: 'TDD gatekeeper',
        defaultModel: 'gpt-5.2',
        vibe: ['direct', 'careful'],
        specialties: ['smoke tests', 'red green handoffs'],
      } satisfies AdminAgentProfile

      const created = agents.create({
        agentId: 'smokey',
        displayName: 'Smokey',
        status: 'active',
        profile,
        actor: ACTOR,
        now: '2026-05-15T01:10:00.000Z',
      })

      expect(created.profile).toEqual(profile)
      expect(agents.get('smokey')?.profile).toEqual(profile)
      expect(agents.list()[0]?.profile).toEqual(profile)
    } finally {
      store.close()
    }
  })

  test('patch null clears profile while empty arrays remain intentional values', () => {
    const store = createInMemoryAdminStore()
    try {
      const agents = profileAgents(store)
      agents.create({
        agentId: 'larry',
        status: 'active',
        profile: {
          displayColor: '#AA00CC',
          monogram: 'LR',
          vibe: ['focused'],
          specialties: ['implementation'],
        },
        actor: ACTOR,
        now: '2026-05-15T01:20:00.000Z',
      })

      const emptied = agents.patch({
        agentId: 'larry',
        profile: {
          vibe: [],
          specialties: [],
        },
        actor: ACTOR,
        now: '2026-05-15T01:21:00.000Z',
      })

      expect(emptied?.profile).toEqual({ vibe: [], specialties: [] })
      expect(agents.get('larry')?.profile).toEqual({ vibe: [], specialties: [] })

      const cleared = agents.patch({
        agentId: 'larry',
        profile: null,
        actor: ACTOR,
        now: '2026-05-15T01:22:00.000Z',
      })

      expect(cleared?.profile).toBeUndefined()
      expect(agents.get('larry')?.profile).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('profile validation rejects invalid write inputs with clear field errors', () => {
    const store = createInMemoryAdminStore()
    try {
      const agents = profileAgents(store)

      expect(() =>
        agents.create({
          agentId: 'bad-color',
          status: 'active',
          profile: { displayColor: 'blue' },
          actor: ACTOR,
          now: '2026-05-15T01:30:00.000Z',
        })
      ).toThrow(/profile\.displayColor.*hex/i)

      expect(() =>
        agents.create({
          agentId: 'bad-monogram',
          status: 'active',
          profile: { monogram: 'LONG' },
          actor: ACTOR,
          now: '2026-05-15T01:31:00.000Z',
        })
      ).toThrow(/profile\.monogram.*1-3/i)

      expect(() =>
        agents.create({
          agentId: 'bad-vibe',
          status: 'active',
          profile: { vibe: ['focused', '   '] },
          actor: ACTOR,
          now: '2026-05-15T01:32:00.000Z',
        })
      ).toThrow(/profile\.vibe.*non-empty/i)
    } finally {
      store.close()
    }
  })
})
