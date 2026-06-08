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

export function toOptionalString(value: string | null): string | undefined {
  return value ?? undefined
}

export function toOptionalNumber(value: number | null): number | undefined {
  return value ?? undefined
}

export function toOptionalBooleanFromInt(value: number | null): boolean | undefined {
  if (value === null) {
    return undefined
  }

  return value !== 0
}

export function parseJsonRecord(
  value: string | null
): Readonly<Record<string, unknown>> | undefined {
  if (value === null) {
    return undefined
  }

  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected JSON object payload')
  }

  return parsed as Readonly<Record<string, unknown>>
}
