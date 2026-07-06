#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openSqliteAdminStore } from 'acp-admin-store'
import type { AdminAgent, AdminAgentProfile } from 'acp-core'
import { createAcpServer } from 'acp-server'

import { createHttpClient } from '../http-client.js'
import type { AgentProfilePatchPayload, FetchLike } from '../http-client.js'
import { AGENT_PROFILE_SEED } from './agent-profile-seed.js'

const DEFAULT_ADMIN_DB_PATH = '/Users/lherron/praesidium/var/db/acp-admin.db'
const DEFAULT_AGENT_ASSETS_DIR = '/Users/lherron/praesidium/var/state/acp-server/assets'
const ACTOR_AGENT_ID = 'seed-agent-profiles'

type SeedSummary = {
  patchedProfiles: number
  copiedAssets: number
  skippedMissingAgents: number
}

type SeedAgentProfilesDeps = {
  adminStore?: ReturnType<typeof openSqliteAdminStore> | undefined
}

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const repoRoot = dirname(dirname(packageRoot))
const pfpSourceDir = join(repoRoot, 'packages/acp-viewer/public/pfp')

export async function seedAgentProfiles(
  env: NodeJS.ProcessEnv = process.env,
  deps: SeedAgentProfilesDeps = {}
): Promise<SeedSummary> {
  const adminDbPath = env['ACP_ADMIN_DB_PATH'] ?? DEFAULT_ADMIN_DB_PATH
  const agentAssetsDir = env['ACP_AGENT_ASSETS_DIR'] ?? DEFAULT_AGENT_ASSETS_DIR

  mkdirSync(dirname(adminDbPath), { recursive: true })
  const adminStore = deps.adminStore ?? openSqliteAdminStore({ dbPath: adminDbPath })
  try {
    const acpServer = createAcpServer({
      adminStore,
      wrkqStore: {} as never,
      coordStore: {} as never,
      interfaceStore: {} as never,
    })
    const client = createHttpClient({
      fetchImpl: createInProcessFetch(acpServer.handler),
    })

    const agents = new Map(
      (await client.listAgents()).agents.map((agent) => [agent.agentId, agent])
    )
    let patchedProfiles = 0
    let skippedMissingAgents = 0

    for (const [agentId, profile] of Object.entries(AGENT_PROFILE_SEED)) {
      const existing = agents.get(agentId)
      if (existing === undefined) {
        skippedMissingAgents += 1
        console.log(`skip ${agentId}: agent not found`)
        continue
      }

      if (profilesEqual(existing.profile, profile)) {
        continue
      }

      const response = await client.patchAgentProfile({
        actorAgentId: ACTOR_AGENT_ID,
        agentId,
        profile: profile satisfies AgentProfilePatchPayload,
      })
      patchedProfiles += 1
      agents.set(agentId, { ...existing, profile: response.agent.profile } as AdminAgent)
    }

    const copiedAssets = copyPfpAssets(agentAssetsDir)
    console.log(
      `patched ${patchedProfiles} profiles, copied ${copiedAssets} assets, skipped ${skippedMissingAgents} missing agents`
    )

    return { patchedProfiles, copiedAssets, skippedMissingAgents }
  } finally {
    if (deps.adminStore === undefined) {
      adminStore.close()
    }
  }
}

function createInProcessFetch(handler: (request: Request) => Promise<Response>): FetchLike {
  return async (input, init) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)
    return handler(request)
  }
}

function copyPfpAssets(agentAssetsDir: string): number {
  if (!existsSync(pfpSourceDir)) {
    return 0
  }

  let copiedAssets = 0
  for (const fileName of readdirSync(pfpSourceDir)
    .filter((entry) => entry.endsWith('.png'))
    .sort()) {
    const agentId = fileName.slice(0, -'.png'.length)
    const sourcePath = join(pfpSourceDir, fileName)
    const targetPath = join(agentAssetsDir, 'agents', agentId, 'pfp.png')

    if (existsSync(targetPath) && sha256(sourcePath) === sha256(targetPath)) {
      continue
    }

    mkdirSync(dirname(targetPath), { recursive: true })
    copyFileSync(sourcePath, targetPath)
    copiedAssets += 1
  }
  return copiedAssets
}

function profilesEqual(
  left: AdminAgentProfile | undefined,
  right: AdminAgentProfile | undefined
): boolean {
  return (
    left?.displayColor === right?.displayColor &&
    left?.monogram === right?.monogram &&
    left?.avatarUrl === right?.avatarUrl &&
    left?.tagline === right?.tagline &&
    left?.role === right?.role &&
    left?.defaultModel === right?.defaultModel &&
    arraysEqual(left?.vibe, right?.vibe) &&
    arraysEqual(left?.specialties, right?.specialties)
  )
}

function arraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

if (import.meta.main) {
  await seedAgentProfiles()
}
