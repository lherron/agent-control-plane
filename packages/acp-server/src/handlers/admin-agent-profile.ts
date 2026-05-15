import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AdminAgentProfile } from 'acp-core'

import { badRequest, json, notFound } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import type { RouteContext, RouteHandler } from '../routing/route-context.js'

// ── Validation helpers ──────────────────────────────────────────────

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const MONOGRAM_RE = /^[\x21-\x7E]{1,3}$/
const PROFILE_ARRAY_LIMIT = 16
const PROFILE_ARRAY_ITEM_LIMIT = 80
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/

type ProfilePatchBody = {
  displayColor?: string | null | undefined
  monogram?: string | null | undefined
  avatarUrl?: string | null | undefined
  tagline?: string | null | undefined
  role?: string | null | undefined
  defaultModel?: string | null | undefined
  vibe?: string[] | null | undefined
  specialties?: string[] | null | undefined
}

function validateOptionalHexColor(value: unknown, present: boolean): string | null | undefined {
  if (!present) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) {
    badRequest('displayColor must be a #RRGGBB hex color', { field: 'profile.displayColor' })
  }
  return value
}

function validateOptionalMonogram(value: unknown, present: boolean): string | null | undefined {
  if (!present) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || !MONOGRAM_RE.test(value)) {
    badRequest('monogram must be 1-3 printable ASCII chars', { field: 'profile.monogram' })
  }
  return value
}

function validateOptionalProfileString(
  value: unknown,
  present: boolean,
  fieldName: string
): string | null | undefined {
  if (!present) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0) {
    badRequest(`${fieldName} must be a non-empty string`, { field: `profile.${fieldName}` })
  }
  return value
}

function validateOptionalStringArray(
  value: unknown,
  present: boolean,
  fieldName: string
): string[] | null | undefined {
  if (!present) return undefined
  if (value === null) return null
  if (!Array.isArray(value)) {
    badRequest(`${fieldName} must be an array of strings`, { field: `profile.${fieldName}` })
  }
  if (value.length > PROFILE_ARRAY_LIMIT) {
    badRequest(`${fieldName} must contain at most ${PROFILE_ARRAY_LIMIT} values`, {
      field: `profile.${fieldName}`,
    })
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      badRequest(`${fieldName} must contain only non-empty strings`, {
        field: `profile.${fieldName}`,
      })
    }
    if (item.trim().length > PROFILE_ARRAY_ITEM_LIMIT) {
      badRequest(`${fieldName} values must be at most ${PROFILE_ARRAY_ITEM_LIMIT} chars`, {
        field: `profile.${fieldName}`,
      })
    }
  }
  return value as string[]
}

function parseProfilePatch(body: Record<string, unknown>): ProfilePatchBody {
  return {
    displayColor: validateOptionalHexColor(body['displayColor'], 'displayColor' in body),
    monogram: validateOptionalMonogram(body['monogram'], 'monogram' in body),
    avatarUrl: validateOptionalProfileString(body['avatarUrl'], 'avatarUrl' in body, 'avatarUrl'),
    tagline: validateOptionalProfileString(body['tagline'], 'tagline' in body, 'tagline'),
    role: validateOptionalProfileString(body['role'], 'role' in body, 'role'),
    defaultModel: validateOptionalProfileString(
      body['defaultModel'],
      'defaultModel' in body,
      'defaultModel'
    ),
    vibe: validateOptionalStringArray(body['vibe'], 'vibe' in body, 'vibe'),
    specialties: validateOptionalStringArray(
      body['specialties'],
      'specialties' in body,
      'specialties'
    ),
  }
}

/**
 * Merge an incoming HTTP profile patch with the existing profile.
 *
 * Semantics (HTTP JSON layer → store AgentProfileInput):
 *   key absent in HTTP body → preserve existing value
 *   key = null              → clear (null → store receives null → column = NULL)
 *   key = value             → set
 */
function mergeProfilePatch(
  existing: AdminAgentProfile | undefined,
  patch: ProfilePatchBody
): {
  displayColor?: string | null | undefined
  monogram?: string | null | undefined
  avatarUrl?: string | null | undefined
  tagline?: string | null | undefined
  role?: string | null | undefined
  defaultModel?: string | null | undefined
  vibe?: string[] | null | undefined
  specialties?: string[] | null | undefined
} {
  const fields = [
    'displayColor',
    'monogram',
    'avatarUrl',
    'tagline',
    'role',
    'defaultModel',
    'vibe',
    'specialties',
  ] as const

  const merged: Record<string, unknown> = {}
  for (const field of fields) {
    const patchValue = patch[field]
    if (patchValue === undefined) {
      // Not in the HTTP body → keep existing
      const existingValue = existing?.[field]
      if (existingValue !== undefined) {
        merged[field] = existingValue
      }
      // If existing is also undefined, we leave it out (undefined → null in store → column NULL)
    } else {
      // null or value: pass through
      merged[field] = patchValue
    }
  }

  return merged
}

function requireActor(context: RouteContext) {
  const actor = context.actor
  if (actor === undefined) {
    badRequest('actor is required', { field: 'actor' })
  }
  return actor
}

function requireAgentId(params: Record<string, string>): string {
  const agentId = params['agentId']
  if (agentId === undefined || agentId.length === 0) {
    badRequest('agentId route param is required', { field: 'agentId' })
  }
  return agentId
}

// ── Handlers ────────────────────────────────────────────────────────

export const handlePatchAdminAgentProfile: RouteHandler = async (context) => {
  const { request, params, deps } = context
  const agentId = requireAgentId(params)
  const existing = deps.adminStore.agents.get(agentId)
  if (existing === undefined) {
    notFound('agent not found', { agentId })
  }

  const body = requireRecord(await parseJsonBody(request))
  const patch = parseProfilePatch(body)
  const merged = mergeProfilePatch(existing.profile, patch)
  const actor = requireActor(context)

  const agent = deps.adminStore.agents.patch({
    agentId,
    profile: merged,
    actor,
    now: new Date().toISOString(),
  })

  return json({ agent: agent ?? existing })
}

export const handleGetAgentPfp: RouteHandler = async ({ params, deps }) => {
  const agentId = params['agentId'] ?? ''

  if (!SAFE_AGENT_ID_RE.test(agentId)) {
    badRequest('agentId contains invalid characters', { field: 'agentId' })
  }

  const agentAssetsDir = deps.agentAssetsDir
  if (agentAssetsDir === undefined) {
    notFound('agent pfp not found', { agentId })
  }

  const filePath = join(agentAssetsDir, agentId, 'pfp.png')
  if (!existsSync(filePath)) {
    notFound('agent pfp not found', { agentId })
  }

  const bytes = readFileSync(filePath)
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
}
