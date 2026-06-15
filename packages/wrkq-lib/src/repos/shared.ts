import type { RoleMap } from 'acp-core'

import type { ActorResolver } from '../actor-resolver.js'
import { WrkqProjectNotFoundError, WrkqTaskNotFoundError } from '../errors.js'
import type { SqliteDatabase } from '../sqlite.js'

export interface RepoContext {
  sqlite: SqliteDatabase
  actorResolver: ActorResolver
}

type ProjectRow = {
  uuid: string
  id: string
  slug: string
}

type TaskLookupRow = {
  uuid: string
  etag: number
}

type RoleAssignmentRow = {
  role: string
  actor_slug: string
}

export function resolveProjectReference(sqlite: SqliteDatabase, projectRef: string): ProjectRow {
  const project = sqlite
    .prepare(
      `SELECT uuid, id, slug
         FROM containers
        WHERE id = ? OR slug = ?
        LIMIT 1`
    )
    .get(projectRef, projectRef) as ProjectRow | undefined

  if (project === undefined) {
    throw new WrkqProjectNotFoundError(projectRef)
  }

  return project
}

export function getTaskLookup(sqlite: SqliteDatabase, taskId: string): TaskLookupRow | undefined {
  return sqlite.prepare('SELECT uuid, etag FROM tasks WHERE id = ?').get(taskId) as
    | TaskLookupRow
    | undefined
}

/**
 * Computes the next zero-padded sequential business ID for a prefixed id column
 * (e.g. `A-00001`, `EV-00001`). The numeric suffix begins immediately after the
 * `${prefix}-` separator, so the `substr` offset is `prefix.length + 2` (1-based
 * SQLite offset past the prefix and the `-`).
 */
export function nextSequentialId(sqlite: SqliteDatabase, table: string, prefix: string): string {
  const substrOffset = prefix.length + 2
  const row = sqlite
    .prepare(
      `SELECT printf('${prefix}-%05d', COALESCE(MAX(CAST(substr(id, ${substrOffset}) AS INTEGER)), 0) + 1) AS id
         FROM ${table}
        WHERE id GLOB '${prefix}-[0-9]*'`
    )
    .get() as { id: string }
  return row.id
}

/**
 * Returns the starting numeric suffix for the next `EV-%05d` evidence id (i.e.
 * `MAX(numeric suffix) + 1`). Callers appending a batch within a single
 * transaction can seed this once and increment in-process to avoid a per-item
 * MAX scan, reproducing the same monotonic sequence a per-item query yields.
 */
export function nextEvidenceSeq(sqlite: SqliteDatabase): number {
  const row = sqlite
    .prepare(
      `SELECT COALESCE(MAX(CAST(substr(id, 4) AS INTEGER)), 0) + 1 AS seq
         FROM evidence_items
        WHERE id GLOB 'EV-[0-9]*'`
    )
    .get() as { seq: number }
  return row.seq
}

export function findTaskUuid(sqlite: SqliteDatabase, taskId: string): string | undefined {
  const task = sqlite.prepare('SELECT uuid FROM tasks WHERE id = ?').get(taskId) as
    | { uuid: string }
    | undefined
  return task?.uuid
}

export function requireTaskLookup(sqlite: SqliteDatabase, taskId: string): TaskLookupRow {
  const task = getTaskLookup(sqlite, taskId)
  if (task === undefined) {
    throw new WrkqTaskNotFoundError(taskId)
  }

  return task
}

export function loadRoleMap(sqlite: SqliteDatabase, taskUuid: string): RoleMap {
  const rows = sqlite
    .prepare(
      `SELECT tra.role, a.slug AS actor_slug
         FROM task_role_assignments AS tra
         JOIN actors AS a ON a.uuid = tra.actor_uuid
        WHERE tra.task_uuid = ?
        ORDER BY tra.role ASC`
    )
    .all(taskUuid) as RoleAssignmentRow[]

  return rows.reduce<Record<string, string>>((roleMap, row) => {
    roleMap[row.role] = row.actor_slug
    return roleMap
  }, {})
}

export function replaceRoleMap(
  sqlite: SqliteDatabase,
  actorResolver: ActorResolver,
  taskUuid: string,
  roleMap: RoleMap
): void {
  sqlite.prepare('DELETE FROM task_role_assignments WHERE task_uuid = ?').run(taskUuid)

  const insert = sqlite.prepare(
    'INSERT INTO task_role_assignments (task_uuid, role, actor_uuid) VALUES (?, ?, ?)'
  )

  for (const [role, agentId] of Object.entries(roleMap) as Array<[string, string]>) {
    const actorUuid = actorResolver.resolveActorUuid({ agentId })
    insert.run(taskUuid, role, actorUuid)
  }
}

export function deriveTaskSlug(taskId: string): string {
  const normalized = taskId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')

  if (normalized.length === 0) {
    return 'task'
  }

  return /^[a-z0-9]/.test(normalized) ? normalized : `task-${normalized}`
}
