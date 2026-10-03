#!/usr/bin/env bun

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { openSqliteAdminStore } from 'acp-admin-store'
import type { AdminAgent, AdminAgentProfile } from 'acp-core'
import { createAcpServer } from 'acp-server'

import { createHttpClient } from '../http-client.js'
import type { AgentProfilePatchPayload, FetchLike } from '../http-client.js'
import { AGENT_PROFILE_SEED } from './agent-profile-seed.js'

const DEFAULT_ADMIN_DB_PATH = '/Users/lherron/praesidium/var/db/acp-admin.db'
const ACTOR_AGENT_ID = 'seed-agent-profiles'

type SeedSummary = {
  patchedProfiles: number
  copiedAssets: number
  skippedMissingAgents: number
}

type SeedAgentProfilesDeps = {
  adminStore?: ReturnType<typeof openSqliteAdminStore> | undefined
}

export async function seedAgentProfiles(
  env: NodeJS.ProcessEnv = process.env,
  deps: SeedAgentProfilesDeps = {}
): Promise<SeedSummary> {
  const adminDbPath = env['ACP_ADMIN_DB_PATH'] ?? DEFAULT_ADMIN_DB_PATH

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

    const copiedAssets = 0
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

function profilesEqual(
  left: AdminAgentProfile | undefined,
  right: AdminAgentProfile | undefined
): boolean {
  return (
    left?.displayColor === right?.displayColor &&
    left?.monogram === right?.monogram &&
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

if (import.meta.main) {
  await seedAgentProfiles()
}
