import { Database as BunDatabase } from 'bun:sqlite'
import { mock } from 'bun:test'

class BetterSqliteStatement {
  constructor(private readonly statement: ReturnType<BunDatabase['prepare']>) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.statement.run(...params)
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const result = this.statement.get(...params) as Record<string, unknown> | null
    return result ?? undefined
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.statement.all(...params) as Record<string, unknown>[]
  }
}

class BetterSqliteShim {
  private readonly database: BunDatabase

  constructor(filename?: string) {
    this.database = new BunDatabase(filename ?? ':memory:')
  }

  prepare(source: string): BetterSqliteStatement {
    return new BetterSqliteStatement(this.database.prepare(source))
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) {
    return this.database.transaction(fn)
  }

  exec(source: string): this {
    this.database.exec(source)
    return this
  }

  pragma(source: string): unknown {
    this.database.exec(`PRAGMA ${source}`)
    return undefined
  }

  close(): this {
    this.database.close(false)
    return this
  }
}

mock.module('better-sqlite3', () => ({
  __esModule: true,
  default: BetterSqliteShim,
}))
