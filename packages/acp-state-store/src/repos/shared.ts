import type { SqliteDatabase } from '../sqlite.js'

export interface RepoContext {
  sqlite: SqliteDatabase
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
