import type { SqliteDatabase } from '../sqlite.js'

export interface RepoContext {
  sqlite: SqliteDatabase
}

export function toOptionalString(value: string | null): string | undefined {
  return value ?? undefined
}
