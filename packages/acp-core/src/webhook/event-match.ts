import type { EventMatch, EventOriginMatch } from './job-trigger.js'
import type { WrkqWebhookEvent } from './wrkq-event.js'

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

function matchesTransition(match: EventMatch['transition'], event: WrkqWebhookEvent): boolean {
  if (match === undefined) {
    return true
  }
  const transition = event.transition ?? undefined
  // A transition predicate requires the event to actually carry a transition.
  if (transition === null || transition === undefined) {
    return false
  }
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

function matchesOrigin(match: EventOriginMatch | undefined, event: WrkqWebhookEvent): boolean {
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
  if (match.kind !== undefined && actorKind(actor) !== match.kind) {
    return false
  }
  return true
}

/**
 * Pure predicate: does this wrkq event satisfy the job's EventMatch? Every
 * present field is ANDed; an absent field is a wildcard. No I/O, no payload
 * mutation — the dispatch tail stays wrkq-agnostic and only mints on `true`.
 */
export function evaluateEventMatch(match: EventMatch, event: WrkqWebhookEvent): boolean {
  if (!matchesEvent(match.event, event.event)) {
    return false
  }
  if (!matchesTransition(match.transition, event)) {
    return false
  }
  if (match.project_scope_id !== undefined && event.project_scope_id !== match.project_scope_id) {
    return false
  }
  if (match.container_path !== undefined) {
    const path = event.container_path
    if (typeof path !== 'string' || !globToRegExp(match.container_path).test(path)) {
      return false
    }
  }
  if (match.kind !== undefined && event.kind !== match.kind) {
    return false
  }
  if (!matchesLabels(match.labels, event.labels)) {
    return false
  }
  if (!matchesOrigin(match.origin, event)) {
    return false
  }
  return true
}
