import type { SqliteDatabase } from './sqlite.js'

export interface StoreActorIdentity {
  agentId: string
  displayName?: string | undefined
}

type ActorRow = {
  uuid: string
}

type NextActorIdRow = {
  id: string
}

export class ActorResolver {
  private readonly cache = new Map<string, string>()

  constructor(
    private readonly sqlite: SqliteDatabase,
    private readonly defaultActor: StoreActorIdentity
  ) {}

  getDefaultActor(): StoreActorIdentity {
    return this.defaultActor
  }

  resolveDefaultActorUuid(): string {
    return this.resolveActorUuid(this.defaultActor)
  }

  resolveActorUuid(actor: StoreActorIdentity): string {
    const cached = this.cache.get(actor.agentId)
    if (cached !== undefined) {
      return cached
    }

    const existing = this.sqlite
      .prepare('SELECT uuid FROM actors WHERE slug = ?')
      .get(actor.agentId) as ActorRow | undefined

    if (existing !== undefined) {
      this.cache.set(actor.agentId, existing.uuid)
      return existing.uuid
    }

    const nextActorId = (
      this.sqlite
        .prepare(
          `SELECT printf('A-%05d', COALESCE(MAX(CAST(substr(id, 3) AS INTEGER)), 0) + 1) AS id
             FROM actors
            WHERE id GLOB 'A-[0-9]*'`
        )
        .get() as NextActorIdRow
    ).id

    this.sqlite
      .prepare('INSERT INTO actors (id, slug, display_name, role) VALUES (?, ?, ?, ?)')
      .run(nextActorId, actor.agentId, actor.displayName ?? actor.agentId, 'agent')

    const created = this.sqlite
      .prepare('SELECT uuid FROM actors WHERE slug = ?')
      .get(actor.agentId) as ActorRow | undefined

    if (created === undefined) {
      throw new Error(`Failed to resolve actor row for slug ${actor.agentId}`)
    }

    this.cache.set(actor.agentId, created.uuid)
    return created.uuid
  }
}
