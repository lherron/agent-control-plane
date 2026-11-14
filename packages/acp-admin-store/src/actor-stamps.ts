import type { Actor } from 'acp-core'

export type MutableActorStamp = {
  createdBy: Actor
  updatedBy: Actor
}

export type ImmutableActorStamp = {
  createdBy: Actor
}

type SystemEventActorStamp = {
  recordedBy: Actor
}

export const DEFAULT_SYSTEM_ACTOR = {
  kind: 'system',
  id: 'acp-admin-store',
} satisfies Actor

function normalizeActor(actor: Actor): Actor {
  return {
    kind: actor.kind,
    id: actor.id,
    ...(actor.displayName !== undefined ? { displayName: actor.displayName } : {}),
  }
}

export function serializeMutableActorStamp(createdBy: Actor, updatedBy: Actor): string {
  return JSON.stringify({
    createdBy: normalizeActor(createdBy),
    updatedBy: normalizeActor(updatedBy),
  } satisfies MutableActorStamp)
}

export function serializeImmutableActorStamp(actor: Actor): string {
  return JSON.stringify({ createdBy: normalizeActor(actor) } satisfies ImmutableActorStamp)
}

export function serializeSystemEventActorStamp(actor: Actor): string {
  return JSON.stringify({ recordedBy: normalizeActor(actor) } satisfies SystemEventActorStamp)
}

export function sameActor(left: Actor, right: Actor): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    (left.displayName ?? undefined) === (right.displayName ?? undefined)
  )
}
