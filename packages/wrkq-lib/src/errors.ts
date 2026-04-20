export class WrkqSchemaMissingError extends Error {
  readonly missing: readonly string[]

  constructor(missing: readonly string[], dbPath: string) {
    super(
      `wrkq schema missing at ${dbPath}: ${missing.join(', ')}. Run wrkq migrations from the Go code before opening this store.`
    )
    this.name = 'WrkqSchemaMissingError'
    this.missing = missing
  }
}

export class WrkqTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`wrkq task not found: ${taskId}`)
    this.name = 'WrkqTaskNotFoundError'
  }
}

export class WrkqProjectNotFoundError extends Error {
  constructor(projectRef: string) {
    super(`wrkq project not found: ${projectRef}`)
    this.name = 'WrkqProjectNotFoundError'
  }
}

export class VersionConflictError extends Error {
  constructor(taskId: string, expectedVersion: number) {
    super(`wrkq task version conflict for ${taskId}: expected version ${expectedVersion}`)
    this.name = 'VersionConflictError'
  }
}
