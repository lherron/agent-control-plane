import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  Actor,
  AdminAgent,
  AdminAgentProfile,
  AdminAgentStatus,
  AdminMembership,
  AdminProject,
  AgentHeartbeat,
  AgentHeartbeatStatus,
  InterfaceIdentity,
  MembershipRole,
  SystemEvent,
} from 'acp-core'

import Database, { type SqliteDatabase } from './sqlite.js'

type MigrationRow = {
  id: string
}

type AgentRow = {
  agent_id: string
  display_name: string | null
  home_dir: string | null
  status: AdminAgentStatus
  created_at: string
  updated_at: string
  actor_stamp: string
  profile_display_color: string | null
  profile_monogram: string | null
  profile_avatar_url: string | null
  profile_tagline: string | null
  profile_role: string | null
  profile_default_model: string | null
  profile_vibe: string | null
  profile_specialties: string | null
}

type ProjectRow = {
  project_id: string
  display_name: string
  default_agent_id: string | null
  root_dir: string | null
  created_at: string
  updated_at: string
  actor_stamp: string
}

type MembershipRow = {
  project_id: string
  agent_id: string
  role: MembershipRole
  created_at: string
  actor_stamp: string
}

type InterfaceIdentityRow = {
  identity_id: string
  gateway_id: string
  external_id: string
  display_name: string | null
  linked_agent_id: string | null
  created_at: string
  updated_at: string
  actor_stamp: string
}

type SystemEventRow = {
  event_id: number | bigint
  project_id: string
  kind: string
  payload: string
  occurred_at: string
  recorded_at: string
  actor_stamp: string
}

type HeartbeatRow = {
  agent_id: string
  last_heartbeat_at: string
  source: string | null
  last_note: string | null
  status: AgentHeartbeatStatus
  target_scope_ref: string | null
  target_lane_ref: string | null
}

type MutableActorStamp = {
  createdBy: Actor
  updatedBy: Actor
}

type ImmutableActorStamp = {
  createdBy: Actor
}

type SystemEventActorStamp = {
  recordedBy: Actor
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

export type AdminStoreMigration = {
  id: string
  sql: string
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

export interface CreateProjectInput {
  projectId: string
  displayName: string
  homeDir?: string | undefined
  rootDir?: string | undefined
  actor: Actor
  now: string
}

export interface ProjectsStore {
  create(input: CreateProjectInput): AdminProject
  list(): AdminProject[]
  get(projectId: string): AdminProject | undefined
  setDefaultAgent(input: {
    projectId: string
    agentId: string
    actor: Actor
    now: string
  }): AdminProject | undefined
}

export interface MembershipsStore {
  add(input: {
    projectId: string
    agentId: string
    role: MembershipRole
    actor: Actor
    now: string
  }): AdminMembership
  listByProject(projectId: string): AdminMembership[]
}

export interface InterfaceIdentitiesStore {
  register(input: {
    gatewayId: string
    externalId: string
    displayName?: string | undefined
    linkedAgentId?: string | undefined
    now: string
  }): InterfaceIdentity
  list(filters?: {
    gatewayId?: string | undefined
    externalId?: string | undefined
  }): InterfaceIdentity[]
  getByCompositeKey(input: { gatewayId: string; externalId: string }): InterfaceIdentity | undefined
}

export interface SystemEventsStore {
  append(input: {
    projectId: string
    kind: string
    payload: Record<string, unknown>
    occurredAt: string
    recordedAt: string
  }): SystemEvent
  list(filters?: {
    projectId?: string | undefined
    kind?: string | undefined
    occurredAfter?: string | undefined
    occurredBefore?: string | undefined
  }): SystemEvent[]
}

export interface UpsertHeartbeatInput {
  agentId: string
  source?: string | undefined
  note?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  now: string
}

export interface HeartbeatsStore {
  upsert(input: UpsertHeartbeatInput): AgentHeartbeat
  get(agentId: string): AgentHeartbeat | undefined
  list(): AgentHeartbeat[]
  listStale(thresholdIso: string): AgentHeartbeat[]
}

/**
 * Default stale-heartbeat threshold: 10 minutes (600_000 ms).
 */
export const STALE_HEARTBEAT_THRESHOLD_MS = 10 * 60 * 1000

export const adminStoreMigrations: readonly AdminStoreMigration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        default_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memberships (
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('coordinator', 'implementer', 'tester', 'observer')),
        created_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL,
        PRIMARY KEY (project_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS memberships_project_created_idx
        ON memberships (project_id, created_at, agent_id);

      CREATE TABLE IF NOT EXISTS interface_identities (
        identity_id TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        display_name TEXT,
        linked_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS interface_identities_gateway_external_unique
        ON interface_identities (gateway_id, external_id);

      CREATE TABLE IF NOT EXISTS system_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        actor_stamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS system_events_project_idx
        ON system_events (project_id, occurred_at, event_id);

      CREATE INDEX IF NOT EXISTS system_events_kind_idx
        ON system_events (kind, occurred_at, event_id);

      CREATE INDEX IF NOT EXISTS system_events_occurred_at_idx
        ON system_events (occurred_at, event_id);
    `,
  },
  {
    id: '002_heartbeats',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_heartbeats (
        agent_id TEXT PRIMARY KEY,
        last_heartbeat_at TEXT NOT NULL,
        source TEXT,
        last_note TEXT,
        status TEXT NOT NULL CHECK (status IN ('alive', 'stale'))
      );
    `,
  },
  {
    id: '003_placement_metadata',
    sql: `
      ALTER TABLE agents ADD COLUMN home_dir TEXT;
      ALTER TABLE projects ADD COLUMN root_dir TEXT;
    `,
  },
  {
    id: '004_heartbeat_target',
    sql: `
      ALTER TABLE agent_heartbeats ADD COLUMN target_scope_ref TEXT;
      ALTER TABLE agent_heartbeats ADD COLUMN target_lane_ref TEXT;
    `,
  },
  {
    id: '005_agent_profile',
    sql: `
      ALTER TABLE agents ADD COLUMN profile_display_color TEXT;
      ALTER TABLE agents ADD COLUMN profile_monogram TEXT;
      ALTER TABLE agents ADD COLUMN profile_avatar_url TEXT;
      ALTER TABLE agents ADD COLUMN profile_tagline TEXT;
      ALTER TABLE agents ADD COLUMN profile_role TEXT;
      ALTER TABLE agents ADD COLUMN profile_default_model TEXT;
      ALTER TABLE agents ADD COLUMN profile_vibe TEXT;
      ALTER TABLE agents ADD COLUMN profile_specialties TEXT;
    `,
  },
]

export interface OpenSqliteAdminStoreOptions {
  dbPath: string
}

export interface AdminStore {
  readonly sqlite: SqliteDatabase
  readonly migrations: {
    applied: string[]
  }
  readonly agents: AgentsStore
  readonly projects: ProjectsStore
  readonly memberships: MembershipsStore
  readonly interfaceIdentities: InterfaceIdentitiesStore
  readonly systemEvents: SystemEventsStore
  readonly heartbeats: HeartbeatsStore
  runInTransaction<T>(fn: (store: AdminStore) => T): T
  close(): void
}

type StoreHandle<TStore> = TStore & {
  readonly sqlite: SqliteDatabase
  readonly migrations: {
    applied: string[]
  }
  runInTransaction<T>(fn: (store: AdminStore) => T): T
  close(): void
}

const DEFAULT_SYSTEM_ACTOR = {
  kind: 'system',
  id: 'acp-admin-store',
} satisfies Actor

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function ensureMigrationTable(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS acp_admin_store_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

const PROFILE_ARRAY_LIMIT = 16
const PROFILE_ARRAY_ITEM_LIMIT = 80

const SQLITE_BUSY_TIMEOUT_MS = 5000
const IDENTITY_ID_HEX_LENGTH = 16

function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (!isEphemeralPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`)
  return sqlite
}

function normalizeActor(actor: Actor): Actor {
  return {
    kind: actor.kind,
    id: actor.id,
    ...(actor.displayName !== undefined ? { displayName: actor.displayName } : {}),
  }
}

function serializeMutableActorStamp(createdBy: Actor, updatedBy: Actor): string {
  return JSON.stringify({
    createdBy: normalizeActor(createdBy),
    updatedBy: normalizeActor(updatedBy),
  } satisfies MutableActorStamp)
}

function serializeImmutableActorStamp(actor: Actor): string {
  return JSON.stringify({ createdBy: normalizeActor(actor) } satisfies ImmutableActorStamp)
}

function serializeSystemEventActorStamp(actor: Actor): string {
  return JSON.stringify({ recordedBy: normalizeActor(actor) } satisfies SystemEventActorStamp)
}

function parseJsonValue<T>(value: string): T {
  return JSON.parse(value) as T
}

// Builds a `WHERE <col> <op> ? AND ...` fragment plus its bound params from a
// list of (column, op, value) filters, skipping entries whose value is
// undefined. Returns an empty clause when no filters are active. The fragment
// and param order are byte-identical to inlining the same filters in sequence.
function buildWhereClause(
  filters: ReadonlyArray<readonly [column: string, op: string, value: string | undefined]>
): { whereClause: string; values: string[] } {
  const clauses: string[] = []
  const values: string[] = []
  for (const [column, op, value] of filters) {
    if (value === undefined) continue
    clauses.push(`${column} ${op} ?`)
    values.push(value)
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return { whereClause, values }
}

function generateIdentityId(): string {
  return `ifid_${randomUUID().replace(/-/g, '').slice(0, IDENTITY_ID_HEX_LENGTH)}`
}

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
    const parsed = parseJsonValue<unknown>(value)
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

function validateOptionalPath(value: string | null | undefined, fieldName: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new Error(`${fieldName} must not be empty when provided`)
  }
  return value
}

function maybeField<K extends string>(
  key: K,
  value: string | null
): { [P in K]: string } | undefined {
  return value === null ? undefined : ({ [key]: value } as { [P in K]: string })
}

function toAdminAgent(row: AgentRow): AdminAgent {
  const stamp = parseJsonValue<MutableActorStamp>(row.actor_stamp)
  return {
    agentId: row.agent_id,
    ...(maybeField('displayName', row.display_name) ?? {}),
    ...(maybeField('homeDir', row.home_dir) ?? {}),
    ...(maybeAgentProfile(row) ?? {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: stamp.createdBy,
    updatedBy: stamp.updatedBy,
  }
}

function toAdminProject(row: ProjectRow): AdminProject {
  const stamp = parseJsonValue<MutableActorStamp>(row.actor_stamp)
  return {
    projectId: row.project_id,
    displayName: row.display_name,
    ...(maybeField('defaultAgentId', row.default_agent_id) ?? {}),
    ...(maybeField('homeDir', row.root_dir) ?? {}),
    ...(maybeField('rootDir', row.root_dir) ?? {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: stamp.createdBy,
    updatedBy: stamp.updatedBy,
  }
}

function toAdminMembership(row: MembershipRow): AdminMembership {
  const stamp = parseJsonValue<ImmutableActorStamp>(row.actor_stamp)
  return {
    projectId: row.project_id,
    agentId: row.agent_id,
    role: row.role,
    createdAt: row.created_at,
    createdBy: stamp.createdBy,
  }
}

function toInterfaceIdentity(row: InterfaceIdentityRow): InterfaceIdentity {
  return {
    gatewayId: row.gateway_id,
    externalId: row.external_id,
    ...(maybeField('displayName', row.display_name) ?? {}),
    ...(maybeField('linkedAgentId', row.linked_agent_id) ?? {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSystemEvent(row: SystemEventRow): SystemEvent {
  return {
    eventId: String(row.event_id),
    projectId: row.project_id,
    kind: row.kind,
    payload: parseJsonValue<Record<string, unknown>>(row.payload),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  }
}

function toAgentHeartbeat(row: HeartbeatRow): AgentHeartbeat {
  return {
    agentId: row.agent_id,
    lastHeartbeatAt: row.last_heartbeat_at,
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.last_note !== null ? { lastNote: row.last_note } : {}),
    status: row.status,
    ...(row.target_scope_ref !== null ? { targetScopeRef: row.target_scope_ref } : {}),
    ...(row.target_lane_ref !== null ? { targetLaneRef: row.target_lane_ref } : {}),
  }
}

function sameActor(left: Actor, right: Actor): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    (left.displayName ?? undefined) === (right.displayName ?? undefined)
  )
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

function createAgentsStore(sqlite: SqliteDatabase): AgentsStore {
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
            `SELECT agent_id, display_name, home_dir, status, created_at, updated_at, actor_stamp,
              profile_display_color, profile_monogram, profile_avatar_url, profile_tagline,
              profile_role, profile_default_model, profile_vibe, profile_specialties
           FROM agents
           ORDER BY created_at ASC, agent_id ASC`
          )
          .all() as AgentRow[]
      ).map(toAdminAgent)
    },

    get(agentId) {
      const row = sqlite
        .prepare(
          `SELECT agent_id, display_name, home_dir, status, created_at, updated_at, actor_stamp,
              profile_display_color, profile_monogram, profile_avatar_url, profile_tagline,
              profile_role, profile_default_model, profile_vibe, profile_specialties
           FROM agents
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

function createProjectsStore(sqlite: SqliteDatabase): ProjectsStore {
  return {
    create(input) {
      const homeDir = validateOptionalPath(input.homeDir, 'homeDir')
      const rootDir = validateOptionalPath(input.rootDir, 'rootDir')
      if (homeDir !== null && rootDir !== null && homeDir !== rootDir) {
        throw new Error('homeDir and rootDir must match when both are provided')
      }
      const projectDir = homeDir ?? rootDir
      const existing = this.get(input.projectId)
      if (existing !== undefined) {
        if (
          existing.displayName === input.displayName &&
          sameActor(existing.createdBy, input.actor)
        ) {
          return existing
        }

        throw new Error(`project ${input.projectId} already exists with different values`)
      }

      sqlite
        .prepare(
          `INSERT INTO projects (
            project_id,
            display_name,
            default_agent_id,
            root_dir,
            created_at,
            updated_at,
            actor_stamp
          ) VALUES (?, ?, NULL, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.displayName,
          projectDir,
          input.now,
          input.now,
          serializeMutableActorStamp(input.actor, input.actor)
        )

      return this.get(input.projectId) as AdminProject
    },

    list() {
      return (
        sqlite
          .prepare(
            `SELECT project_id, display_name, default_agent_id, root_dir, created_at, updated_at, actor_stamp
           FROM projects
           ORDER BY created_at ASC, project_id ASC`
          )
          .all() as ProjectRow[]
      ).map(toAdminProject)
    },

    get(projectId) {
      const row = sqlite
        .prepare(
          `SELECT project_id, display_name, default_agent_id, root_dir, created_at, updated_at, actor_stamp
           FROM projects
           WHERE project_id = ?`
        )
        .get(projectId) as ProjectRow | undefined

      return row === undefined ? undefined : toAdminProject(row)
    },

    setDefaultAgent(input) {
      const existing = this.get(input.projectId)
      if (existing === undefined) {
        return undefined
      }

      sqlite
        .prepare(
          `UPDATE projects
           SET default_agent_id = ?, updated_at = ?, actor_stamp = ?
           WHERE project_id = ?`
        )
        .run(
          input.agentId,
          input.now,
          serializeMutableActorStamp(existing.createdBy, input.actor),
          input.projectId
        )

      return this.get(input.projectId)
    },
  }
}

function createMembershipsStore(sqlite: SqliteDatabase): MembershipsStore {
  return {
    add(input) {
      const existing = sqlite
        .prepare(
          `SELECT project_id, agent_id, role, created_at, actor_stamp
           FROM memberships
           WHERE project_id = ? AND agent_id = ?`
        )
        .get(input.projectId, input.agentId) as MembershipRow | undefined

      if (existing !== undefined) {
        const membership = toAdminMembership(existing)
        if (membership.role === input.role && sameActor(membership.createdBy, input.actor)) {
          return membership
        }

        throw new Error(
          `membership ${input.projectId}/${input.agentId} already exists with different values`
        )
      }

      sqlite
        .prepare(
          `INSERT INTO memberships (project_id, agent_id, role, created_at, actor_stamp)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.agentId,
          input.role,
          input.now,
          serializeImmutableActorStamp(input.actor)
        )

      const row = sqlite
        .prepare(
          `SELECT project_id, agent_id, role, created_at, actor_stamp
           FROM memberships
           WHERE project_id = ? AND agent_id = ?`
        )
        .get(input.projectId, input.agentId) as MembershipRow | undefined

      if (row === undefined) {
        throw new Error('membership insert failed')
      }

      return toAdminMembership(row)
    },

    listByProject(projectId) {
      return (
        sqlite
          .prepare(
            `SELECT project_id, agent_id, role, created_at, actor_stamp
           FROM memberships
           WHERE project_id = ?
           ORDER BY created_at ASC, agent_id ASC`
          )
          .all(projectId) as MembershipRow[]
      ).map(toAdminMembership)
    },
  }
}

function createInterfaceIdentitiesStore(sqlite: SqliteDatabase): InterfaceIdentitiesStore {
  return {
    register(input) {
      const existing = sqlite
        .prepare(
          `SELECT identity_id, gateway_id, external_id, display_name, linked_agent_id, created_at, updated_at, actor_stamp
           FROM interface_identities
           WHERE gateway_id = ? AND external_id = ?`
        )
        .get(input.gatewayId, input.externalId) as InterfaceIdentityRow | undefined

      if (existing === undefined) {
        const identityId = generateIdentityId()
        sqlite
          .prepare(
            `INSERT INTO interface_identities (
              identity_id,
              gateway_id,
              external_id,
              display_name,
              linked_agent_id,
              created_at,
              updated_at,
              actor_stamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            identityId,
            input.gatewayId,
            input.externalId,
            input.displayName ?? null,
            input.linkedAgentId ?? null,
            input.now,
            input.now,
            serializeMutableActorStamp(DEFAULT_SYSTEM_ACTOR, DEFAULT_SYSTEM_ACTOR)
          )

        return this.getByCompositeKey({
          gatewayId: input.gatewayId,
          externalId: input.externalId,
        }) as InterfaceIdentity
      }

      const current = toInterfaceIdentity(existing)
      const nextDisplayName = input.displayName ?? current.displayName
      const nextLinkedAgentId = input.linkedAgentId ?? current.linkedAgentId
      if (
        sameOptionalString(current.displayName, nextDisplayName) &&
        sameOptionalString(current.linkedAgentId, nextLinkedAgentId)
      ) {
        return current
      }

      sqlite
        .prepare(
          `UPDATE interface_identities
           SET display_name = ?, linked_agent_id = ?, updated_at = ?, actor_stamp = ?
           WHERE identity_id = ?`
        )
        .run(
          nextDisplayName ?? null,
          nextLinkedAgentId ?? null,
          input.now,
          serializeMutableActorStamp(DEFAULT_SYSTEM_ACTOR, DEFAULT_SYSTEM_ACTOR),
          existing.identity_id
        )

      return this.getByCompositeKey({
        gatewayId: input.gatewayId,
        externalId: input.externalId,
      }) as InterfaceIdentity
    },

    list(filters = {}) {
      const { whereClause, values } = buildWhereClause([
        ['gateway_id', '=', filters.gatewayId],
        ['external_id', '=', filters.externalId],
      ])
      return (
        sqlite
          .prepare(
            `SELECT identity_id, gateway_id, external_id, display_name, linked_agent_id, created_at, updated_at, actor_stamp
           FROM interface_identities
           ${whereClause}
           ORDER BY created_at ASC, gateway_id ASC, external_id ASC`
          )
          .all(...values) as InterfaceIdentityRow[]
      ).map(toInterfaceIdentity)
    },

    getByCompositeKey(input) {
      const row = sqlite
        .prepare(
          `SELECT identity_id, gateway_id, external_id, display_name, linked_agent_id, created_at, updated_at, actor_stamp
           FROM interface_identities
           WHERE gateway_id = ? AND external_id = ?`
        )
        .get(input.gatewayId, input.externalId) as InterfaceIdentityRow | undefined

      return row === undefined ? undefined : toInterfaceIdentity(row)
    },
  }
}

function createSystemEventsStore(sqlite: SqliteDatabase): SystemEventsStore {
  return {
    append(input) {
      const result = sqlite
        .prepare(
          `INSERT INTO system_events (
            project_id,
            kind,
            payload,
            occurred_at,
            recorded_at,
            actor_stamp
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.kind,
          JSON.stringify(input.payload),
          input.occurredAt,
          input.recordedAt,
          serializeSystemEventActorStamp(DEFAULT_SYSTEM_ACTOR)
        )

      const row = sqlite
        .prepare(
          `SELECT event_id, project_id, kind, payload, occurred_at, recorded_at, actor_stamp
           FROM system_events
           WHERE event_id = ?`
        )
        .get(result.lastInsertRowid) as SystemEventRow | undefined

      if (row === undefined) {
        throw new Error('system event insert failed')
      }

      return toSystemEvent(row)
    },

    list(filters) {
      const { whereClause, values } = buildWhereClause([
        ['project_id', '=', filters?.projectId],
        ['kind', '=', filters?.kind],
        ['occurred_at', '>', filters?.occurredAfter],
        ['occurred_at', '<', filters?.occurredBefore],
      ])
      return (
        sqlite
          .prepare(
            `SELECT event_id, project_id, kind, payload, occurred_at, recorded_at, actor_stamp
           FROM system_events
           ${whereClause}
           ORDER BY occurred_at ASC, event_id ASC`
          )
          .all(...values) as SystemEventRow[]
      ).map(toSystemEvent)
    },
  }
}

function createHeartbeatsStore(sqlite: SqliteDatabase): HeartbeatsStore {
  return {
    upsert(input) {
      // When scopeRef/laneRef are provided, persist them.
      // When not provided, preserve existing values on update.
      const hasScopeRef = input.scopeRef !== undefined
      const hasLaneRef = input.laneRef !== undefined

      if (hasScopeRef || hasLaneRef) {
        // When scopeRef is set and laneRef is not, default laneRef to 'main'
        const effectiveLaneRef = input.laneRef ?? (hasScopeRef ? 'main' : null)
        sqlite
          .prepare(
            `INSERT INTO agent_heartbeats (
              agent_id,
              last_heartbeat_at,
              source,
              last_note,
              status,
              target_scope_ref,
              target_lane_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (agent_id) DO UPDATE SET
              last_heartbeat_at = excluded.last_heartbeat_at,
              source = excluded.source,
              last_note = excluded.last_note,
              status = excluded.status,
              target_scope_ref = COALESCE(excluded.target_scope_ref, agent_heartbeats.target_scope_ref),
              target_lane_ref = COALESCE(excluded.target_lane_ref, agent_heartbeats.target_lane_ref)`
          )
          .run(
            input.agentId,
            input.now,
            input.source ?? null,
            input.note ?? null,
            'alive' satisfies AgentHeartbeatStatus,
            input.scopeRef ?? null,
            effectiveLaneRef
          )
      } else {
        sqlite
          .prepare(
            `INSERT INTO agent_heartbeats (
              agent_id,
              last_heartbeat_at,
              source,
              last_note,
              status
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (agent_id) DO UPDATE SET
              last_heartbeat_at = excluded.last_heartbeat_at,
              source = excluded.source,
              last_note = excluded.last_note,
              status = excluded.status`
          )
          .run(
            input.agentId,
            input.now,
            input.source ?? null,
            input.note ?? null,
            'alive' satisfies AgentHeartbeatStatus
          )
      }

      return this.get(input.agentId) as AgentHeartbeat
    },

    get(agentId) {
      const row = sqlite
        .prepare(
          `SELECT agent_id, last_heartbeat_at, source, last_note, status, target_scope_ref, target_lane_ref
           FROM agent_heartbeats
           WHERE agent_id = ?`
        )
        .get(agentId) as HeartbeatRow | undefined

      return row === undefined ? undefined : toAgentHeartbeat(row)
    },

    list() {
      return (
        sqlite
          .prepare(
            `SELECT agent_id, last_heartbeat_at, source, last_note, status, target_scope_ref, target_lane_ref
           FROM agent_heartbeats
           ORDER BY last_heartbeat_at DESC, agent_id ASC`
          )
          .all() as HeartbeatRow[]
      ).map(toAgentHeartbeat)
    },

    listStale(thresholdIso) {
      return (
        sqlite
          .prepare(
            `SELECT agent_id, last_heartbeat_at, source, last_note, status, target_scope_ref, target_lane_ref
           FROM agent_heartbeats
           WHERE last_heartbeat_at < ?
           ORDER BY last_heartbeat_at ASC, agent_id ASC`
          )
          .all(thresholdIso) as HeartbeatRow[]
      ).map(toAgentHeartbeat)
    },
  }
}

function createStoreHandle<TStore extends object>(
  store: AdminStore,
  section: TStore
): StoreHandle<TStore> {
  return {
    ...section,
    sqlite: store.sqlite,
    migrations: store.migrations,
    runInTransaction: store.runInTransaction.bind(store),
    close: store.close.bind(store),
  }
}

export function listAppliedAdminStoreMigrations(sqlite: SqliteDatabase): string[] {
  ensureMigrationTable(sqlite)
  return (
    sqlite
      .prepare('SELECT id FROM acp_admin_store_migrations ORDER BY id ASC')
      .all() as MigrationRow[]
  ).map((row) => row.id)
}

export function runAdminStoreMigrations(sqlite: SqliteDatabase): void {
  ensureMigrationTable(sqlite)
  const applied = new Set(listAppliedAdminStoreMigrations(sqlite))

  sqlite.transaction((pending: readonly AdminStoreMigration[]) => {
    for (const migration of pending) {
      if (applied.has(migration.id)) {
        continue
      }

      if (migration.sql.trim().length > 0) {
        sqlite.exec(migration.sql)
      }
      sqlite
        .prepare('INSERT INTO acp_admin_store_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
    }
  })(adminStoreMigrations)
}

export function openSqliteAdminStore(options: OpenSqliteAdminStoreOptions): AdminStore {
  const sqlite = createSqliteDatabase(options.dbPath)
  runAdminStoreMigrations(sqlite)

  const agents = createAgentsStore(sqlite)
  const projects = createProjectsStore(sqlite)
  const memberships = createMembershipsStore(sqlite)
  const interfaceIdentities = createInterfaceIdentitiesStore(sqlite)
  const systemEvents = createSystemEventsStore(sqlite)
  const heartbeats = createHeartbeatsStore(sqlite)

  const store = {
    sqlite,
    migrations: {
      applied: listAppliedAdminStoreMigrations(sqlite),
    },
    agents,
    projects,
    memberships,
    interfaceIdentities,
    systemEvents,
    heartbeats,
    runInTransaction<T>(fn: (activeStore: AdminStore) => T): T {
      return sqlite.transaction(() => fn(store))()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies AdminStore

  return store
}

export function createInMemoryAdminStore(): AdminStore {
  return openSqliteAdminStore({ dbPath: ':memory:' })
}

export function openSqliteAgentsStore(
  options: OpenSqliteAdminStoreOptions
): StoreHandle<AgentsStore> {
  const store = openSqliteAdminStore(options)
  return createStoreHandle(store, store.agents)
}

export function createInMemoryAgentsStore(): StoreHandle<AgentsStore> {
  const store = createInMemoryAdminStore()
  return createStoreHandle(store, store.agents)
}

export function openSqliteProjectsStore(
  options: OpenSqliteAdminStoreOptions
): StoreHandle<ProjectsStore> {
  const store = openSqliteAdminStore(options)
  return createStoreHandle(store, store.projects)
}

export function createInMemoryProjectsStore(): StoreHandle<ProjectsStore> {
  const store = createInMemoryAdminStore()
  return createStoreHandle(store, store.projects)
}

export function openSqliteMembershipsStore(
  options: OpenSqliteAdminStoreOptions
): StoreHandle<MembershipsStore> {
  const store = openSqliteAdminStore(options)
  return createStoreHandle(store, store.memberships)
}

export function createInMemoryMembershipsStore(): StoreHandle<MembershipsStore> {
  const store = createInMemoryAdminStore()
  return createStoreHandle(store, store.memberships)
}

export function openSqliteInterfaceIdentitiesStore(
  options: OpenSqliteAdminStoreOptions
): StoreHandle<InterfaceIdentitiesStore> {
  const store = openSqliteAdminStore(options)
  return createStoreHandle(store, store.interfaceIdentities)
}

export function createInMemoryInterfaceIdentitiesStore(): StoreHandle<InterfaceIdentitiesStore> {
  const store = createInMemoryAdminStore()
  return createStoreHandle(store, store.interfaceIdentities)
}

export function openSqliteSystemEventsStore(
  options: OpenSqliteAdminStoreOptions
): StoreHandle<SystemEventsStore> {
  const store = openSqliteAdminStore(options)
  return createStoreHandle(store, store.systemEvents)
}

export function createInMemorySystemEventsStore(): StoreHandle<SystemEventsStore> {
  const store = createInMemoryAdminStore()
  return createStoreHandle(store, store.systemEvents)
}

export function openSqliteHeartbeatsStore(
  options: OpenSqliteAdminStoreOptions
): StoreHandle<HeartbeatsStore> {
  const store = openSqliteAdminStore(options)
  return createStoreHandle(store, store.heartbeats)
}

export function createInMemoryHeartbeatsStore(): StoreHandle<HeartbeatsStore> {
  const store = createInMemoryAdminStore()
  return createStoreHandle(store, store.heartbeats)
}
