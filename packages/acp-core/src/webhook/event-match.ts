import type { AcpWebhookEvent } from './acp-event.js'
import type {
  EventMatch,
  EventOriginMatch,
  EventSubjectMatch,
  JsonScalar,
  PayloadPathPredicate,
} from './job-trigger.js'

/**
 * Compile a glob (supporting `*` and `**` and `?`) into a RegExp. `**` matches
 * across path separators; `*` matches within a single segment; `?` one char.
 */
function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch as string)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  out += '$'
  return new RegExp(out)
}

function matchesEvent(match: EventMatch['event'], event: string): boolean {
  if (match === undefined) {
    return true
  }
  return Array.isArray(match) ? match.includes(event) : match === event
}

function payloadRecord(event: AcpWebhookEvent): Readonly<Record<string, unknown>> {
  return event.payload
}

function matchesSubject(match: EventSubjectMatch | undefined, event: AcpWebhookEvent): boolean {
  if (match === undefined) {
    return true
  }
  if (match.type !== undefined) {
    const subjectType = event.subject?.type
    if (typeof subjectType !== 'string') {
      return false
    }
    return Array.isArray(match.type) ? match.type.includes(subjectType) : match.type === subjectType
  }
  return true
}

function matchesTransition(match: EventMatch['transition'], event: AcpWebhookEvent): boolean {
  if (match === undefined) {
    return true
  }
  const rawTransition = payloadRecord(event)['transition']
  // A transition predicate requires the event to actually carry a transition.
  if (
    rawTransition === null ||
    rawTransition === undefined ||
    typeof rawTransition !== 'object' ||
    Array.isArray(rawTransition)
  ) {
    return false
  }
  const transition = rawTransition as { from?: unknown; to?: unknown }
  if (match.to !== undefined && transition.to !== match.to) {
    return false
  }
  if (match.from !== undefined) {
    const eventFrom = transition.from ?? null
    const matchFrom = match.from ?? null
    if (eventFrom !== matchFrom) {
      return false
    }
  }
  return true
}

function matchesLabels(match: EventMatch['labels'], eventLabels: string[] | undefined): boolean {
  if (match === undefined || match.length === 0) {
    return true
  }
  const present = new Set(eventLabels ?? [])
  return match.every((label) => present.has(label))
}

/** Actor kind = the prefix before ':' ("human:lance" → "human"; bare "system" → "system"). */
function actorKind(actor: string): string {
  const idx = actor.indexOf(':')
  return idx === -1 ? actor : actor.slice(0, idx)
}

function matchesOrigin(match: EventOriginMatch | undefined, event: AcpWebhookEvent): boolean {
  if (match === undefined) {
    return true
  }
  const actor = event.origin?.actor
  if (typeof actor !== 'string') {
    return false
  }
  if (match.actor !== undefined) {
    const ok = Array.isArray(match.actor) ? match.actor.includes(actor) : match.actor === actor
    if (!ok) {
      return false
    }
  }
  const kind = event.origin?.kind ?? actorKind(actor)
  if (match.kind !== undefined && kind !== match.kind) {
    return false
  }
  return true
}

function payloadValueAtPath(
  payload: Readonly<Record<string, unknown>>,
  path: string
): { exists: boolean; value: unknown } {
  let current: unknown = payload
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { exists: false, value: undefined }
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { exists: false, value: undefined }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return { exists: true, value: current }
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function scalarEqual(left: unknown, right: JsonScalar): boolean {
  return isJsonScalar(left) && Object.is(left, right)
}

function matchesPayloadPredicate(
  predicate: PayloadPathPredicate,
  found: { exists: boolean; value: unknown }
): boolean {
  if (predicate.exists !== undefined && found.exists !== predicate.exists) {
    return false
  }
  if (predicate.eq !== undefined && (!found.exists || !scalarEqual(found.value, predicate.eq))) {
    return false
  }
  if (
    predicate.anyOf !== undefined &&
    (!found.exists || !predicate.anyOf.some((candidate) => scalarEqual(found.value, candidate)))
  ) {
    return false
  }
  return true
}

function matchesPayload(
  predicates: EventMatch['payload'],
  payload: Readonly<Record<string, unknown>>
): boolean {
  if (predicates === undefined) {
    return true
  }
  for (const [path, predicate] of Object.entries(predicates)) {
    if (!matchesPayloadPredicate(predicate, payloadValueAtPath(payload, path))) {
      return false
    }
  }
  return true
}

/**
 * Pure predicate: does this normalized ACP event satisfy the job's EventMatch? Every
 * present field is ANDed; an absent field is a wildcard. No I/O, no payload
 * mutation — the dispatch tail stays source-agnostic and only mints on `true`.
 */
export function evaluateEventMatch(match: EventMatch, event: AcpWebhookEvent): boolean {
  if (!matchesEvent(match.event, event.event)) {
    return false
  }
  if (!matchesSubject(match.subject, event)) {
    return false
  }
  if (!matchesTransition(match.transition, event)) {
    return false
  }
  const payload = payloadRecord(event)
  if (
    match.project_scope_id !== undefined &&
    payload['project_scope_id'] !== match.project_scope_id
  ) {
    return false
  }
  if (match.container_path !== undefined) {
    const path = payload['container_path']
    if (typeof path !== 'string' || !globToRegExp(match.container_path).test(path)) {
      return false
    }
  }
  if (match.kind !== undefined && payload['kind'] !== match.kind) {
    return false
  }
  if (
    !matchesLabels(
      match.labels,
      Array.isArray(payload['labels']) ? (payload['labels'] as string[]) : undefined
    )
  ) {
    return false
  }
  if (!matchesOrigin(match.origin, event)) {
    return false
  }
  if (!matchesPayload(match.payload, payload)) {
    return false
  }
  return true
}
