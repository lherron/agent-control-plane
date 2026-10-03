import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSqliteAdminStore } from 'acp-admin-store'
import type { AdminAgent, AdminAgentProfile } from 'acp-core'

import { AGENT_PROFILE_SEED } from '../src/seed/agent-profile-seed.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const seedScriptPath = join(packageRoot, 'src/seed/seed-agent-profiles.ts')
const seededPfpAgentIds = ['clod', 'cody', 'larry'] as const
const missingAgentId = 'virtu'
const actor = { kind: 'agent', id: 'smokey', displayName: 'Smokey' } as const

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('agent profile seed script', () => {
  test('patches metadata idempotently without copying or seeding avatars', async () => {
    const fixture = createFixture()
    const existingAgentIds = Object.keys(AGENT_PROFILE_SEED).filter(
      (agentId) => agentId !== missingAgentId
    )
    createAgents(fixture.dbPath, existingAgentIds)

    const firstRun = await runSeedScript(fixture)
    expectSeedRunSucceeded(firstRun)

    const firstAgents = readAgents(fixture.dbPath)

    for (const agentId of existingAgentIds) {
      expect(firstAgents.find((agent) => agent.agentId === agentId)?.profile).toEqual(
        AGENT_PROFILE_SEED[agentId as keyof typeof AGENT_PROFILE_SEED]
      )
    }
    expect(firstAgents.some((agent) => agent.agentId === missingAgentId)).toBe(false)

    for (const agentId of seededPfpAgentIds) {
      expect(existsSync(join(fixture.assetsDir, 'agents', agentId, 'pfp.png'))).toBe(false)
      expect(
        firstAgents.find((agent) => agent.agentId === agentId)?.profile?.avatarUrl
      ).toBeUndefined()
    }

    const secondRun = await runSeedScript(fixture)
    expectSeedRunSucceeded(secondRun)

    expect(readAgents(fixture.dbPath)).toEqual(firstAgents)
  })

  test('can seed through an already-open admin store without competing for the sqlite writer', async () => {
    const fixture = createFixture()
    createAgents(fixture.dbPath, ['clod'])
    const store = openSqliteAdminStore({ dbPath: fixture.dbPath })
    const { seedAgentProfiles } = await import('../src/seed/seed-agent-profiles.ts')
    const seedWithDeps = seedAgentProfiles as unknown as (
      env: NodeJS.ProcessEnv,
      deps: { adminStore: ReturnType<typeof openSqliteAdminStore> }
    ) => Promise<{ patchedProfiles: number; copiedAssets: number; skippedMissingAgents: number }>

    let result:
      | { patchedProfiles: number; copiedAssets: number; skippedMissingAgents: number }
      | undefined
    let thrown: string | undefined
    store.sqlite.exec('BEGIN IMMEDIATE')
    try {
      // T-05830 red: drain-depth validation found this seed path can collide with
      // an already-open ACP admin DB. The helper must reuse an injected store
      // instead of opening a second sqlite writer for the same file.
      result = await seedWithDeps(
        {
          ...Bun.env,
          ACP_ADMIN_DB_PATH: fixture.dbPath,
          ACP_AGENT_ASSETS_DIR: fixture.assetsDir,
        },
        { adminStore: store }
      )
    } catch (error) {
      thrown = describeSeedError(error)
    } finally {
      store.sqlite.exec('ROLLBACK')
      store.close()
    }

    expect(thrown).toBeUndefined()
    expect(result?.patchedProfiles).toBe(1)
  }, 12_000)
})

function createFixture(): { dbPath: string; assetsDir: string } {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? '/tmp', 'acp-agent-profile-seed-'))
  tmpDirs.push(root)
  return {
    dbPath: join(root, 'acp-admin.db'),
    assetsDir: join(root, 'assets'),
  }
}

function createAgents(dbPath: string, agentIds: string[]): void {
  const store = openSqliteAdminStore({ dbPath })
  try {
    for (const agentId of agentIds) {
      store.agents.create({
        agentId,
        displayName: agentId,
        status: 'active',
        actor,
        now: '2026-05-15T00:00:00.000Z',
      })
    }
  } finally {
    store.close()
  }
}

function readAgents(dbPath: string): AdminAgent[] {
  const store = openSqliteAdminStore({ dbPath })
  try {
    return store.agents.list().map(normalizeAgent)
  } finally {
    store.close()
  }
}

function normalizeAgent(agent: AdminAgent): AdminAgent {
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    status: agent.status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    createdBy: agent.createdBy,
    updatedBy: agent.updatedBy,
    ...(agent.homeDir !== undefined ? { homeDir: agent.homeDir } : {}),
    ...(agent.profile !== undefined ? { profile: normalizeProfile(agent.profile) } : {}),
  }
}

function normalizeProfile(profile: AdminAgentProfile): AdminAgentProfile {
  return {
    ...(profile.displayColor !== undefined ? { displayColor: profile.displayColor } : {}),
    ...(profile.monogram !== undefined ? { monogram: profile.monogram } : {}),
    ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
    ...(profile.tagline !== undefined ? { tagline: profile.tagline } : {}),
    ...(profile.role !== undefined ? { role: profile.role } : {}),
    ...(profile.defaultModel !== undefined ? { defaultModel: profile.defaultModel } : {}),
    ...(profile.vibe !== undefined ? { vibe: profile.vibe } : {}),
    ...(profile.specialties !== undefined ? { specialties: profile.specialties } : {}),
  }
}

async function runSeedScript(fixture: { dbPath: string; assetsDir: string }): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn({
    cmd: [process.execPath, seedScriptPath],
    cwd: packageRoot,
    env: {
      ...Bun.env,
      ACP_ADMIN_DB_PATH: fixture.dbPath,
      ACP_AGENT_ASSETS_DIR: fixture.assetsDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

function expectSeedRunSucceeded(run: { exitCode: number; stdout: string; stderr: string }): void {
  if (run.exitCode !== 0) {
    throw new Error(
      [
        `seed script exited with code ${run.exitCode}`,
        'stdout:',
        run.stdout.trim() || '<empty>',
        'stderr:',
        run.stderr.trim() || '<empty>',
      ].join('\n')
    )
  }
}

function describeSeedError(error: unknown): string {
  const body = readErrorBody(error)
  return [
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    body !== undefined ? JSON.stringify(body) : undefined,
  ]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join('\n')
}

function readErrorBody(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || !('body' in error)) {
    return undefined
  }
  return (error as { body?: unknown }).body
}
