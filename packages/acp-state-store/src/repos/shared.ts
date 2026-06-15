import { randomUUID } from 'node:crypto'

import type { Actor } from 'acp-core'

import type { SqliteDatabase } from '../sqlite.js'

export interface RepoContext {
  sqlite: SqliteDatabase
}

/** Length of the hex slice used for repo-local short ids. */
export const SHORT_ID_LEN = 12

/** Default actor attributed to records created without an explicit actor. */
export const DEFAULT_SYSTEM_ACTOR: Actor = { kind: 'system', id: 'acp-local' }

/**
 * Generate a prefixed short id, e.g. `shortId('run_')` → `run_<12 hex chars>`.
 * Mirrors the prior inline `randomUUID().replace(/-/g, '').slice(0, 12)` idiom.
 */
export function shortId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, SHORT_ID_LEN)}`
}

/** Append a `(column)` suffix to a parse-error message when a label is given. */
function withParseContext(message: string, context?: string): string {
  return context === undefined ? message : `${message} (${context})`
}

export function parseJsonRecord(
  value: string | null,
  context?: string
): Readonly<Record<string, unknown>> | undefined {
  if (value === null) {
    return undefined
  }

  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(withParseContext('Expected JSON object payload', context))
  }

  return parsed as Readonly<Record<string, unknown>>
}

export function parseStringArray(value: string, context?: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(withParseContext('Expected JSON array payload', context))
  }

  return parsed as string[]
}
