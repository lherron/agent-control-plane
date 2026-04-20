import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'

const schemaDumpPath = '/Users/lherron/praesidium/wrkq/schema_dump.sql'

function readSchemaDump(): string {
  return readFileSync(schemaDumpPath, 'utf8').replace(
    /^CREATE TABLE sqlite_sequence\(name,seq\);\n?/m,
    ''
  )
}

export type SeededWrkqFixture = {
  dbPath: string
  close(): void
  cleanup(): void
  seed: {
    bootstrapActorUuid: string
    projectUuid: string
    projectId: string
    projectSlug: string
    secondaryProjectUuid: string
    secondaryProjectId: string
    secondaryProjectSlug: string
  }
}

export function createSeededWrkqDb(): SeededWrkqFixture {
  const directory = mkdtempSync(join(tmpdir(), 'wrkq-lib-'))
  const dbPath = join(directory, 'wrkq.db')
  const sqlite = new Database(dbPath)
  let closed = false
  sqlite.exec(readSchemaDump())

  const bootstrapActorUuid = randomUUID()
  sqlite
    .prepare('INSERT INTO actors (uuid, id, slug, display_name, role) VALUES (?, ?, ?, ?, ?)')
    .run(bootstrapActorUuid, 'A-00001', 'bootstrap', 'Bootstrap', 'human')

  const projectUuid = randomUUID()
  const secondaryProjectUuid = randomUUID()

  sqlite
    .prepare(
      `INSERT INTO containers (
         uuid,
         id,
         slug,
         title,
         kind,
         created_by_actor_uuid,
         updated_by_actor_uuid
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectUuid,
      'P-00001',
      'demo',
      'Demo Project',
      'project',
      bootstrapActorUuid,
      bootstrapActorUuid
    )
  sqlite
    .prepare(
      `INSERT INTO containers (
         uuid,
         id,
         slug,
         title,
         kind,
         created_by_actor_uuid,
         updated_by_actor_uuid
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      secondaryProjectUuid,
      'P-00002',
      'demo-two',
      'Demo Project Two',
      'project',
      bootstrapActorUuid,
      bootstrapActorUuid
    )

  return {
    dbPath,
    close() {
      if (closed) {
        return
      }

      sqlite.close()
      closed = true
    },
    cleanup() {
      if (!closed) {
        sqlite.close()
        closed = true
      }

      rmSync(directory, { recursive: true, force: true })
    },
    seed: {
      bootstrapActorUuid,
      projectUuid,
      projectId: 'P-00001',
      projectSlug: 'demo',
      secondaryProjectUuid,
      secondaryProjectId: 'P-00002',
      secondaryProjectSlug: 'demo-two',
    },
  }
}

export function withSeededWrkqDb<T>(run: (fixture: SeededWrkqFixture) => T): T {
  const fixture = createSeededWrkqDb()

  try {
    return run(fixture)
  } finally {
    fixture.cleanup()
  }
}
