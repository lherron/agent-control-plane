export type SqliteRunResult = {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabase {
  prepare(source: string): SqliteStatement
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult
  exec(source: string): unknown
  pragma(source: string): unknown
  close(): unknown
}

export interface SqliteDatabaseConstructor {
  new (filename?: string): SqliteDatabase
}

async function loadSqliteDatabaseConstructor(): Promise<SqliteDatabaseConstructor> {
  if (typeof Bun !== 'undefined') {
    const { Database: BunDatabase } = await import('bun:sqlite')

    class BunSqliteStatement implements SqliteStatement {
      constructor(
        private readonly statement: ReturnType<InstanceType<typeof BunDatabase>['prepare']>
      ) {}

      run(...params: unknown[]): SqliteRunResult {
        const result = this.statement.run(...(params as never[]))
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        }
      }

      get(...params: unknown[]): unknown {
        const result = this.statement.get(...(params as never[]))
        return result ?? undefined
      }

      all(...params: unknown[]): unknown[] {
        return this.statement.all(...(params as never[])) as unknown[]
      }
    }

    class BunSqliteDatabase implements SqliteDatabase {
      private readonly database: InstanceType<typeof BunDatabase>

      constructor(filename?: string) {
        this.database = new BunDatabase(filename ?? ':memory:')
      }

      prepare(source: string): SqliteStatement {
        return new BunSqliteStatement(this.database.prepare(source))
      }

      transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) {
        return this.database.transaction(fn)
      }

      exec(source: string): this {
        this.database.exec(source)
        return this
      }

      pragma(source: string): undefined {
        this.database.exec(`PRAGMA ${source}`)
        return undefined
      }

      close(): this {
        this.database.close(false)
        return this
      }
    }

    return BunSqliteDatabase
  }

  const module = await import('better-sqlite3')
  return module.default as unknown as SqliteDatabaseConstructor
}

const SqliteDatabase = await loadSqliteDatabaseConstructor()

export default SqliteDatabase
