import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Actor, ConversationTurnRenderState } from 'acp-core'
import { type SessionRef, normalizeSessionRef } from 'agent-scope'

import Database, { type SqliteDatabase } from './sqlite.js'

type MigrationRow = {
  id: string
}

export type ConversationStoreMigration = {
  id: string
  sql: string
}

export const conversationStoreMigrations: readonly ConversationStoreMigration[] = [
  {
    id: '001_initial',
    sql: '',
  },
  {
    id: '002_conversation_threads_and_turns',
    sql: `
      CREATE TABLE IF NOT EXISTS conversation_threads (
        threadId TEXT PRIMARY KEY,
        gatewayId TEXT NOT NULL,
        conversationRef TEXT NOT NULL,
        threadRef TEXT NOT NULL DEFAULT '',
        sessionRefScopeRef TEXT,
        sessionRefLaneRef TEXT,
        audience TEXT NOT NULL CHECK (audience IN ('human', 'operator', 'internal')),
        title TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_threads_composite
        ON conversation_threads (gatewayId, conversationRef, threadRef);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        turnId TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('human', 'assistant', 'system')),
        body TEXT NOT NULL,
        renderState TEXT NOT NULL CHECK (renderState IN ('pending', 'streaming', 'delivered', 'failed', 'redacted')),
        actorKind TEXT,
        actorId TEXT,
        sentAt TEXT NOT NULL,
        linksInputAttemptId TEXT,
        linksRunId TEXT,
        linksTaskId TEXT,
        linksHandoffId TEXT,
        linksDeliveryRequestId TEXT,
        linksCoordinationEventId TEXT,
        failureReason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_thread_sentAt
        ON conversation_turns (threadId, sentAt);
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_linksRunId
        ON conversation_turns (linksRunId);
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_linksDeliveryRequestId
        ON conversation_turns (linksDeliveryRequestId);
    `,
  },
]

export interface OpenSqliteConversationStoreOptions {
  dbPath: string
}

export type ConversationAudience = 'human' | 'operator' | 'internal'

export type ConversationThread = {
  threadId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  createdAt: string
  sessionRef?: SessionRef | undefined
  title?: string | undefined
  audience: ConversationAudience
}

export type ConversationTurnLinks = {
  inputAttemptId?: string | undefined
  runId?: string | undefined
  taskId?: string | undefined
  handoffId?: string | undefined
  deliveryRequestId?: string | undefined
  coordinationEventId?: string | undefined
}

export type StoredConversationTurn = {
  turnId: string
  threadId: string
  role: 'human' | 'assistant' | 'system'
  body: string
  renderState: ConversationTurnRenderState
  links?: ConversationTurnLinks | undefined
  actor?: Actor | undefined
  sentAt: string
  failureReason?: string | undefined
}

export interface ConversationStore {
  readonly sqlite: SqliteDatabase
  readonly migrations: {
    applied: string[]
  }
  runInTransaction<T>(fn: (store: ConversationStore) => T): T
  close(): void

  createOrGetThread(input: {
    gatewayId: string
    conversationRef: string
    threadRef?: string | undefined
    sessionRef?: SessionRef | undefined
    title?: string | undefined
    audience: ConversationAudience
  }): ConversationThread

  getThread(threadId: string): ConversationThread | undefined

  listThreads(filters?: {
    projectId?: string | undefined
    sessionRef?: SessionRef | undefined
  }): readonly ConversationThread[]

  createTurn(input: {
    threadId: string
    role: 'human' | 'assistant' | 'system'
    body: string
    renderState: ConversationTurnRenderState
    links?: ConversationTurnLinks | undefined
    actor?: Actor | undefined
    sentAt: string
  }): string

  updateRenderState(
    turnId: string,
    nextState: ConversationTurnRenderState,
    options?: { failureReason?: string | undefined }
  ): StoredConversationTurn

  attachLinks(turnId: string, links: ConversationTurnLinks): StoredConversationTurn

  listTurns(
    threadId: string,
    options?: { since?: string | undefined; limit?: number | undefined }
  ): readonly StoredConversationTurn[]

  findTurnByLink(
    field: 'linksRunId' | 'linksDeliveryRequestId',
    value: string
  ): StoredConversationTurn | undefined
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function ensureMigrationTable(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS acp_conversation_store_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (!isEphemeralPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  return sqlite
}

export function listAppliedConversationStoreMigrations(sqlite: SqliteDatabase): string[] {
  ensureMigrationTable(sqlite)
  return (
    sqlite
      .prepare('SELECT id FROM acp_conversation_store_migrations ORDER BY id ASC')
      .all() as MigrationRow[]
  ).map((row) => row.id)
}

export function runConversationStoreMigrations(sqlite: SqliteDatabase): void {
  ensureMigrationTable(sqlite)
  const applied = new Set(listAppliedConversationStoreMigrations(sqlite))

  sqlite.transaction((pending: readonly ConversationStoreMigration[]) => {
    for (const migration of pending) {
      if (applied.has(migration.id)) {
        continue
      }

      if (migration.sql.trim().length > 0) {
        sqlite.exec(migration.sql)
      }
      sqlite
        .prepare('INSERT INTO acp_conversation_store_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
    }
  })(conversationStoreMigrations)
}

// ---------- Row types for SQLite read-back ----------

type ThreadRow = {
  threadId: string
  gatewayId: string
  conversationRef: string
  threadRef: string
  sessionRefScopeRef: string | null
  sessionRefLaneRef: string | null
  audience: string
  title: string | null
  createdAt: string
}

type TurnRow = {
  turnId: string
  threadId: string
  role: string
  body: string
  renderState: string
  actorKind: string | null
  actorId: string | null
  sentAt: string
  linksInputAttemptId: string | null
  linksRunId: string | null
  linksTaskId: string | null
  linksHandoffId: string | null
  linksDeliveryRequestId: string | null
  linksCoordinationEventId: string | null
  failureReason: string | null
}

function threadRowToThread(row: ThreadRow): ConversationThread {
  return {
    threadId: row.threadId,
    gatewayId: row.gatewayId,
    conversationRef: row.conversationRef,
    ...(row.threadRef !== '' ? { threadRef: row.threadRef } : {}),
    createdAt: row.createdAt,
    ...(row.sessionRefScopeRef !== null && row.sessionRefLaneRef !== null
      ? {
          sessionRef: normalizeSessionRef({
            scopeRef: row.sessionRefScopeRef,
            laneRef: row.sessionRefLaneRef,
          }),
        }
      : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    audience: row.audience as ConversationAudience,
  }
}

function turnRowToTurn(row: TurnRow): StoredConversationTurn {
  const links: ConversationTurnLinks = {}
  let hasLinks = false
  if (row.linksInputAttemptId !== null) {
    links.inputAttemptId = row.linksInputAttemptId
    hasLinks = true
  }
  if (row.linksRunId !== null) {
    links.runId = row.linksRunId
    hasLinks = true
  }
  if (row.linksTaskId !== null) {
    links.taskId = row.linksTaskId
    hasLinks = true
  }
  if (row.linksHandoffId !== null) {
    links.handoffId = row.linksHandoffId
    hasLinks = true
  }
  if (row.linksDeliveryRequestId !== null) {
    links.deliveryRequestId = row.linksDeliveryRequestId
    hasLinks = true
  }
  if (row.linksCoordinationEventId !== null) {
    links.coordinationEventId = row.linksCoordinationEventId
    hasLinks = true
  }

  return {
    turnId: row.turnId,
    threadId: row.threadId,
    role: row.role as StoredConversationTurn['role'],
    body: row.body,
    renderState: row.renderState as ConversationTurnRenderState,
    ...(hasLinks ? { links } : {}),
    ...(row.actorKind !== null && row.actorId !== null
      ? { actor: { kind: row.actorKind as Actor['kind'], id: row.actorId } }
      : {}),
    sentAt: row.sentAt,
    ...(row.failureReason !== null ? { failureReason: row.failureReason } : {}),
  }
}

// ---------- Render-state transition rules ----------

const LEGAL_TRANSITIONS: Record<ConversationTurnRenderState, Set<ConversationTurnRenderState>> = {
  pending: new Set(['streaming', 'delivered', 'failed', 'redacted']),
  streaming: new Set(['delivered', 'failed', 'redacted']),
  delivered: new Set(['redacted']),
  failed: new Set(['redacted']),
  redacted: new Set(),
}

function assertLegalTransition(
  current: ConversationTurnRenderState,
  next: ConversationTurnRenderState
): void {
  if (!LEGAL_TRANSITIONS[current].has(next)) {
    throw new Error(`Invalid render state transition: ${current} → ${next}`)
  }
}

export function openSqliteConversationStore(
  options: OpenSqliteConversationStoreOptions
): ConversationStore {
  const sqlite = createSqliteDatabase(options.dbPath)
  runConversationStoreMigrations(sqlite)

  const store: ConversationStore = {
    sqlite,
    migrations: {
      applied: listAppliedConversationStoreMigrations(sqlite),
    },
    runInTransaction<T>(fn: (store: ConversationStore) => T): T {
      const transaction = sqlite.transaction(() => fn(store))
      return transaction()
    },
    close(): void {
      sqlite.close()
    },

    // ---------- Thread API ----------

    createOrGetThread(input) {
      const threadRef = input.threadRef ?? ''
      const existing = sqlite
        .prepare(
          'SELECT * FROM conversation_threads WHERE gatewayId = ? AND conversationRef = ? AND threadRef = ?'
        )
        .get(input.gatewayId, input.conversationRef, threadRef) as ThreadRow | undefined

      if (existing !== undefined) {
        return threadRowToThread(existing)
      }

      const threadId = `ct_${randomUUID().replace(/-/g, '')}`
      const now = new Date().toISOString()
      sqlite
        .prepare(
          `INSERT INTO conversation_threads
            (threadId, gatewayId, conversationRef, threadRef, sessionRefScopeRef, sessionRefLaneRef, audience, title, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          threadId,
          input.gatewayId,
          input.conversationRef,
          threadRef,
          input.sessionRef?.scopeRef ?? null,
          input.sessionRef?.laneRef ?? null,
          input.audience,
          input.title ?? null,
          now
        )

      return threadRowToThread(
        sqlite
          .prepare('SELECT * FROM conversation_threads WHERE threadId = ?')
          .get(threadId) as ThreadRow
      )
    },

    getThread(threadId) {
      const row = sqlite
        .prepare('SELECT * FROM conversation_threads WHERE threadId = ?')
        .get(threadId) as ThreadRow | undefined
      return row !== undefined ? threadRowToThread(row) : undefined
    },

    listThreads(filters) {
      if (filters?.sessionRef !== undefined) {
        const rows = sqlite
          .prepare(
            'SELECT * FROM conversation_threads WHERE sessionRefScopeRef = ? AND sessionRefLaneRef = ? ORDER BY createdAt ASC'
          )
          .all(filters.sessionRef.scopeRef, filters.sessionRef.laneRef) as ThreadRow[]
        return rows.map(threadRowToThread)
      }

      if (filters?.projectId !== undefined) {
        const pattern = `%:project:${filters.projectId}:%`
        const rows = sqlite
          .prepare(
            'SELECT * FROM conversation_threads WHERE sessionRefScopeRef LIKE ? ORDER BY createdAt ASC'
          )
          .all(pattern) as ThreadRow[]
        return rows.map(threadRowToThread)
      }

      const rows = sqlite
        .prepare('SELECT * FROM conversation_threads ORDER BY createdAt ASC')
        .all() as ThreadRow[]
      return rows.map(threadRowToThread)
    },

    // ---------- Turn API ----------

    createTurn(input) {
      const turnId = `ctn_${randomUUID().replace(/-/g, '')}`
      sqlite
        .prepare(
          `INSERT INTO conversation_turns
            (turnId, threadId, role, body, renderState, actorKind, actorId, sentAt,
             linksInputAttemptId, linksRunId, linksTaskId, linksHandoffId,
             linksDeliveryRequestId, linksCoordinationEventId, failureReason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          turnId,
          input.threadId,
          input.role,
          input.body,
          input.renderState,
          input.actor?.kind ?? null,
          input.actor?.id ?? null,
          input.sentAt,
          input.links?.inputAttemptId ?? null,
          input.links?.runId ?? null,
          input.links?.taskId ?? null,
          input.links?.handoffId ?? null,
          input.links?.deliveryRequestId ?? null,
          input.links?.coordinationEventId ?? null,
          null
        )
      return turnId
    },

    updateRenderState(turnId, nextState, options) {
      const row = sqlite.prepare('SELECT * FROM conversation_turns WHERE turnId = ?').get(turnId) as
        | TurnRow
        | undefined

      if (row === undefined) {
        throw new Error(`turn not found: ${turnId}`)
      }

      assertLegalTransition(row.renderState as ConversationTurnRenderState, nextState)

      const failureReason = options?.failureReason ?? null
      sqlite
        .prepare(
          'UPDATE conversation_turns SET renderState = ?, failureReason = COALESCE(?, failureReason) WHERE turnId = ?'
        )
        .run(nextState, failureReason, turnId)

      return turnRowToTurn(
        sqlite.prepare('SELECT * FROM conversation_turns WHERE turnId = ?').get(turnId) as TurnRow
      )
    },

    attachLinks(turnId, links) {
      const row = sqlite.prepare('SELECT * FROM conversation_turns WHERE turnId = ?').get(turnId) as
        | TurnRow
        | undefined

      if (row === undefined) {
        throw new Error(`turn not found: ${turnId}`)
      }

      // Merge-only: never overwrite existing non-null link
      const updates: string[] = []
      const params: unknown[] = []

      if (links.inputAttemptId !== undefined && row.linksInputAttemptId === null) {
        updates.push('linksInputAttemptId = ?')
        params.push(links.inputAttemptId)
      }
      if (links.runId !== undefined && row.linksRunId === null) {
        updates.push('linksRunId = ?')
        params.push(links.runId)
      }
      if (links.taskId !== undefined && row.linksTaskId === null) {
        updates.push('linksTaskId = ?')
        params.push(links.taskId)
      }
      if (links.handoffId !== undefined && row.linksHandoffId === null) {
        updates.push('linksHandoffId = ?')
        params.push(links.handoffId)
      }
      if (links.deliveryRequestId !== undefined && row.linksDeliveryRequestId === null) {
        updates.push('linksDeliveryRequestId = ?')
        params.push(links.deliveryRequestId)
      }
      if (links.coordinationEventId !== undefined && row.linksCoordinationEventId === null) {
        updates.push('linksCoordinationEventId = ?')
        params.push(links.coordinationEventId)
      }

      if (updates.length > 0) {
        sqlite
          .prepare(`UPDATE conversation_turns SET ${updates.join(', ')} WHERE turnId = ?`)
          .run(...params, turnId)
      }

      return turnRowToTurn(
        sqlite.prepare('SELECT * FROM conversation_turns WHERE turnId = ?').get(turnId) as TurnRow
      )
    },

    listTurns(threadId, options) {
      let sql = 'SELECT * FROM conversation_turns WHERE threadId = ?'
      const params: unknown[] = [threadId]

      if (options?.since !== undefined) {
        sql += ' AND sentAt > ?'
        params.push(options.since)
      }

      sql += ' ORDER BY sentAt ASC'

      if (options?.limit !== undefined) {
        sql += ' LIMIT ?'
        params.push(options.limit)
      }

      const rows = sqlite.prepare(sql).all(...params) as TurnRow[]
      return rows.map(turnRowToTurn)
    },

    findTurnByLink(field, value) {
      const row = sqlite
        .prepare(`SELECT * FROM conversation_turns WHERE ${field} = ? LIMIT 1`)
        .get(value) as TurnRow | undefined
      return row !== undefined ? turnRowToTurn(row) : undefined
    },
  }

  return store
}

export function createInMemoryConversationStore(): ConversationStore {
  return openSqliteConversationStore({ dbPath: ':memory:' })
}
