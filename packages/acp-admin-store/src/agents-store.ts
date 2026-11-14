import type { Actor, AdminAgent, AdminAgentProfile, AdminAgentStatus } from 'acp-core'
import { type MutableActorStamp, sameActor, serializeMutableActorStamp } from './actor-stamps.js'
import { validateOptionalPath } from './placement-path.js'
import type { SqliteDatabase } from './sqlite.js'

type AgentRow = AgentProfileColumns & {
  agent_id: string
  display_name: string | null
  home_dir: string | null
  status: AdminAgentStatus
  created_at: string
  updated_at: string
  actor_stamp: string
}

type AgentProfileInput = {
  displayColor?: string | null | undefined
  monogram?: string | null | undefined
  avatarUrl?: string | null | undefined
  tagline?: string | null | undefined
  role?: string | null | undefined
  defaultModel?: string | null | undefined
  vibe?: string[] | null | undefined
  specialties?: string[] | null | undefined
}

type AgentProfileColumns = {
  profile_display_color: string | null
  profile_monogram: string | null
  profile_avatar_url: string | null
  profile_tagline: string | null
  profile_role: string | null
  profile_default_model: string | null
  profile_vibe: string | null
  profile_specialties: string | null
}

export interface CreateAgentInput {
  agentId: string
  displayName?: string | undefined
  homeDir?: string | undefined
  profile?: AgentProfileInput | null | undefined
  status: AdminAgentStatus
  actor: Actor
  now: string
}

export interface PatchAgentInput {
  agentId: string
  displayName?: string | undefined
  homeDir?: string | null | undefined
  profile?: AgentProfileInput | null | undefined
  status?: AdminAgentStatus | undefined
  actor: Actor
  now: string
}

export interface AgentsStore {
  create(input: CreateAgentInput): AdminAgent
  list(): AdminAgent[]
  get(agentId: string): AdminAgent | undefined
  patch(input: PatchAgentInput): AdminAgent | undefined
}

const PROFILE_ARRAY_LIMIT = 16

const PROFILE_ARRAY_ITEM_LIMIT = 80

const EMPTY_AGENT_PROFILE_COLUMNS: AgentProfileColumns = {
  profile_display_color: null,
  profile_monogram: null,
  profile_avatar_url: null,
  profile_tagline: null,
  profile_role: null,
  profile_default_model: null,
  profile_vibe: null,
  profile_specialties: null,
}

function validateProfileDisplayColor(
  value: string | null | undefined,
  fieldName: string
): string | null {
  if (value === undefined || value === null) return null
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`${fieldName} must be a #RRGGBB hex color`)
  }
  return value
}

function validateProfileMonogram(
  value: string | null | undefined,
  fieldName: string
): string | null {
  if (value === undefined || value === null) return null
  if (!/^[\x21-\x7E]{1,3}$/.test(value)) {
    throw new Error(`${fieldName} must be 1-3 printable ASCII chars`)
  }
  return value
}

function validateProfileString(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value
}

function validateProfileStringArray(
  value: string[] | null | undefined,
  fieldName: string
): string | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`)
  }
  if (value.length > PROFILE_ARRAY_LIMIT) {
    throw new Error(`${fieldName} must contain at most ${PROFILE_ARRAY_LIMIT} values`)
  }

  const normalized = value.map((item) => {
    if (typeof item !== 'string') {
      throw new Error(`${fieldName} must contain only strings`)
    }
    const trimmed = item.trim()
    if (trimmed.length === 0) {
      throw new Error(`${fieldName} must contain only non-empty strings`)
    }
    if (trimmed.length > PROFILE_ARRAY_ITEM_LIMIT) {
      throw new Error(
        `${fieldName} values must contain at most ${PROFILE_ARRAY_ITEM_LIMIT} characters`
      )
    }
    return trimmed
  })

  return JSON.stringify(normalized)
}

function agentProfileToColumns(profile: AgentProfileInput | null | undefined): AgentProfileColumns {
  if (profile === undefined || profile === null) {
    return { ...EMPTY_AGENT_PROFILE_COLUMNS }
  }

  return {
    profile_display_color: validateProfileDisplayColor(
      profile.displayColor,
      'profile.displayColor'
    ),
    profile_monogram: validateProfileMonogram(profile.monogram, 'profile.monogram'),
    profile_avatar_url: validateProfileString(profile.avatarUrl),
    profile_tagline: validateProfileString(profile.tagline),
    profile_role: validateProfileString(profile.role),
    profile_default_model: validateProfileString(profile.defaultModel),
    profile_vibe: validateProfileStringArray(profile.vibe, 'profile.vibe'),
    profile_specialties: validateProfileStringArray(profile.specialties, 'profile.specialties'),
  }
}

function profileScalarFromStorage(
  value: string | null,
  validator: (value: string, fieldName: string) => string | null,
  fieldName: string
): string | undefined {
  if (value === null) return undefined
  try {
    return validator(value, fieldName) ?? undefined
  } catch {
    // Deliberate read-tolerance: stored values may predate a validation
    // tightening. Drop (treat as absent) rather than failing the read so
    // legacy rows remain loadable. Do NOT convert this to a throw.
    return undefined
  }
}

function profileStringFromStorage(value: string | null): string | undefined {
  return value === null ? undefined : value
}

function profileArrayFromStorage(value: string | null, fieldName: string): string[] | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return undefined
    const normalized = parsed.map((item) => {
      if (typeof item !== 'string') {
        throw new Error(`${fieldName} must contain only strings`)
      }
      const trimmed = item.trim()
      if (trimmed.length === 0 || trimmed.length > PROFILE_ARRAY_ITEM_LIMIT) {
        throw new Error(`${fieldName} contains an invalid string`)
      }
      return trimmed
    })
    if (normalized.length > PROFILE_ARRAY_LIMIT) return undefined
    return normalized
  } catch {
    return undefined
  }
}

function maybeAgentProfile(row: AgentProfileColumns): { profile: AdminAgentProfile } | undefined {
  const displayColor = profileScalarFromStorage(
    row.profile_display_color,
    validateProfileDisplayColor,
    'profile.displayColor'
  )
  const monogram = profileScalarFromStorage(
    row.profile_monogram,
    validateProfileMonogram,
    'profile.monogram'
  )
  const avatarUrl = profileStringFromStorage(row.profile_avatar_url)
  const tagline = profileStringFromStorage(row.profile_tagline)
  const role = profileStringFromStorage(row.profile_role)
  const defaultModel = profileStringFromStorage(row.profile_default_model)
  const vibe = profileArrayFromStorage(row.profile_vibe, 'profile.vibe')
  const specialties = profileArrayFromStorage(row.profile_specialties, 'profile.specialties')

  const profile = {
    ...(displayColor !== undefined ? { displayColor } : {}),
    ...(monogram !== undefined ? { monogram } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(tagline !== undefined ? { tagline } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(vibe !== undefined ? { vibe } : {}),
    ...(specialties !== undefined ? { specialties } : {}),
  } satisfies AdminAgentProfile

  return Object.keys(profile).length === 0 ? undefined : { profile }
}

function toAdminAgent(row: AgentRow): AdminAgent {
  const stamp = JSON.parse(row.actor_stamp) as MutableActorStamp
  return {
    agentId: row.agent_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.home_dir === null ? {} : { homeDir: row.home_dir }),
    ...(maybeAgentProfile(row) ?? {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: stamp.createdBy,
    updatedBy: stamp.updatedBy,
  }
}

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return (left ?? undefined) === (right ?? undefined)
}

function sameOptionalStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === undefined && right === undefined
  }
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameOptionalAgentProfile(
  left: AdminAgentProfile | undefined,
  right: AdminAgentProfile | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === undefined && right === undefined
  }

  return (
    sameOptionalString(left.displayColor, right.displayColor) &&
    sameOptionalString(left.monogram, right.monogram) &&
    sameOptionalString(left.avatarUrl, right.avatarUrl) &&
    sameOptionalString(left.tagline, right.tagline) &&
    sameOptionalString(left.role, right.role) &&
    sameOptionalString(left.defaultModel, right.defaultModel) &&
    sameOptionalStringArray(left.vibe, right.vibe) &&
    sameOptionalStringArray(left.specialties, right.specialties)
  )
}

const SELECT_RECORD = `SELECT agent_id, display_name, home_dir, status, created_at, updated_at, actor_stamp,
              profile_display_color, profile_monogram, profile_avatar_url, profile_tagline,
              profile_role, profile_default_model, profile_vibe, profile_specialties
           FROM agents`

export function createAgentsStore(sqlite: SqliteDatabase): AgentsStore {
  return {
    create(input) {
      const homeDir = validateOptionalPath(input.homeDir, 'homeDir')
      const profileColumns = agentProfileToColumns(input.profile)
      const inputProfile = maybeAgentProfile(profileColumns)?.profile
      const existing = this.get(input.agentId)
      if (existing !== undefined) {
        if (
          sameOptionalString(existing.displayName, input.displayName) &&
          (input.profile === undefined ||
            sameOptionalAgentProfile(existing.profile, inputProfile)) &&
          existing.status === input.status &&
          sameActor(existing.createdBy, input.actor)
        ) {
          return existing
        }

        throw new Error(`agent ${input.agentId} already exists with different values`)
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
            actor_stamp,
            profile_display_color,
            profile_monogram,
            profile_avatar_url,
            profile_tagline,
            profile_role,
            profile_default_model,
            profile_vibe,
            profile_specialties
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.agentId,
          input.displayName ?? null,
          homeDir,
          input.status,
          input.now,
          input.now,
          serializeMutableActorStamp(input.actor, input.actor),
          profileColumns.profile_display_color,
          profileColumns.profile_monogram,
          profileColumns.profile_avatar_url,
          profileColumns.profile_tagline,
          profileColumns.profile_role,
          profileColumns.profile_default_model,
          profileColumns.profile_vibe,
          profileColumns.profile_specialties
        )

      return this.get(input.agentId) as AdminAgent
    },

    list() {
      return (
        sqlite
          .prepare(
            `${SELECT_RECORD}
           ORDER BY created_at ASC, agent_id ASC`
          )
          .all() as AgentRow[]
      ).map(toAdminAgent)
    },

    get(agentId) {
      const row = sqlite
        .prepare(
          `${SELECT_RECORD}
           WHERE agent_id = ?`
        )
        .get(agentId) as AgentRow | undefined

      return row === undefined ? undefined : toAdminAgent(row)
    },

    patch(input) {
      const existing = this.get(input.agentId)
      if (existing === undefined) {
        return undefined
      }

      // homeDir: undefined means no change, null means clear, string means set
      const resolvedHomeDir =
        input.homeDir === undefined
          ? (existing.homeDir ?? null)
          : input.homeDir === null
            ? null
            : validateOptionalPath(input.homeDir, 'homeDir')
      const profileColumns =
        input.profile === undefined
          ? agentProfileToColumns(existing.profile)
          : agentProfileToColumns(input.profile)

      sqlite
        .prepare(
          `UPDATE agents
           SET display_name = ?,
               home_dir = ?,
               status = ?,
               updated_at = ?,
               actor_stamp = ?,
               profile_display_color = ?,
               profile_monogram = ?,
               profile_avatar_url = ?,
               profile_tagline = ?,
               profile_role = ?,
               profile_default_model = ?,
               profile_vibe = ?,
               profile_specialties = ?
           WHERE agent_id = ?`
        )
        .run(
          input.displayName ?? existing.displayName ?? null,
          resolvedHomeDir,
          input.status ?? existing.status,
          input.now,
          serializeMutableActorStamp(existing.createdBy, input.actor),
          profileColumns.profile_display_color,
          profileColumns.profile_monogram,
          profileColumns.profile_avatar_url,
          profileColumns.profile_tagline,
          profileColumns.profile_role,
          profileColumns.profile_default_model,
          profileColumns.profile_vibe,
          profileColumns.profile_specialties,
          input.agentId
        )

      return this.get(input.agentId)
    },
  }
}
