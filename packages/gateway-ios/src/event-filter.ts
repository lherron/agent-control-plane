/**
 * Event filter: determines whether an HRC lifecycle event is relevant
 * to a specific mobile session timeline.
 *
 * Used by the event-pump to filter lifecycle events to only those
 * affecting the requested session. Diagnostics may bypass when no
 * session filter is set.
 */

import type { HrcLifecycleEvent } from 'hrc-core'

/**
 * Build the canonical sessionRef from an HRC event's scope and lane.
 *
 * The scopeRef already includes the "agent:" prefix (e.g. "agent:cody:project:agent-spaces"),
 * so the canonical format is `<scopeRef>/lane:<laneRef>`.
 */
export function sessionRefFromEvent(event: HrcLifecycleEvent): string {
  return `${event.scopeRef}/lane:${event.laneRef}`
}

/**
 * Returns true if the given HRC lifecycle event is relevant to the
 * specified sessionRef.
 *
 * An event is relevant when its derived sessionRef (from scopeRef + laneRef)
 * matches the requested sessionRef.
 */
export function isRelevantToSession(event: HrcLifecycleEvent, sessionRef: string): boolean {
  return sessionRefFromEvent(event) === sessionRef
}

/**
 * Returns true if the given HRC lifecycle event matches the optional
 * category filter. When no category filter is provided, all events pass.
 */
export function matchesCategory(event: HrcLifecycleEvent, category?: string): boolean {
  if (!category) return true
  return event.category === category
}

/**
 * Returns true if the given HRC lifecycle event matches the optional
 * eventKind filter. When no eventKind filter is provided, all events pass.
 */
export function matchesEventKind(event: HrcLifecycleEvent, eventKind?: string): boolean {
  if (!eventKind) return true
  return event.eventKind === eventKind
}
