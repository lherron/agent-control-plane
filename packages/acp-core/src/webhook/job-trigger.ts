/**
 * Job trigger union: the generalization of the cron-only job trigger into a
 * `{schedule | event}` discriminated union. A "webhook rule" IS an
 * event-triggered job — the action half (input/flow) and the dispatch tail are
 * unchanged; only the trigger half gains an event variant.
 *
 * Stored as a `{kind,...}` JSON blob with a denormalized `trigger_kind` column
 * for claim filtering (acp-jobs-store). Parsed/validated here via typed
 * accessors — no ad-hoc JSON reads downstream.
 */

import { isRecord } from '../internal/guards.js'

export type EventMatch = {
  /** Event type(s) to match: "created" | "updated" | ... (string or any-of list). */
  event?: string | string[] | undefined
  /** Match canonical subject fields. */
  subject?: EventSubjectMatch | undefined
  /** Match the state transition. `from` may be explicitly null (e.g. created). */
  transition?: { from?: string | null | undefined; to?: string | undefined } | undefined
  /** Exact match on the root container slug (scope-ref ready). */
  project_scope_id?: string | undefined
  /** Glob match against the full container path. */
  container_path?: string | undefined
  /** All listed labels must be present on the task. */
  labels?: string[] | undefined
  /** Exact match on task kind. */
  kind?: string | undefined
  /** Filter on the mutation's origin (e.g. only human-created tasks). */
  origin?: EventOriginMatch | undefined
  /** Deterministic bounded payload path predicates. No expressions. */
  payload?: Record<string, PayloadPathPredicate> | undefined
}

export type JsonScalar = string | number | boolean | null

export type PayloadPathPredicate = {
  eq?: JsonScalar | undefined
  anyOf?: JsonScalar[] | undefined
  exists?: boolean | undefined
}

export type EventSubjectMatch = {
  type?: string | string[] | undefined
}

export type EventOriginMatch = {
  /** Exact match on origin.actor ("human:lance" | "agent:cody" | "system"), or any-of list. */
  actor?: string | string[] | undefined
  /** Match the actor kind: human | agent | system (prefix of origin.actor). */
  kind?: 'human' | 'agent' | 'system' | undefined
}

export type ScheduleTrigger = {
  kind: 'schedule'
  cron: string
  windowStart?: string | undefined
  windowEnd?: string | undefined
  windowMinutes?: number | undefined
  catchUp?: 'none' | 'one' | undefined
}

export type OriginPolicy = {
  /**
   * Whether agent-origin (`agent:*`) events may trigger this job.
   * 'deny-self' blocks only the job's own agent (fail-closed on inexact
   * agent actors). Absent policy defaults to 'deny'; compiled agent-authored
   * hooks always carry an explicit 'deny-self' (daedalus #13229).
   */
  agent: 'deny' | 'deny-self' | 'allow'
}

export type EventTrigger = {
  kind: 'event'
  source: string
  match: EventMatch
  /** Loop/cascade control. Defaults to { agent: 'deny' } when absent. */
  originPolicy?: OriginPolicy | undefined
  /** Per-(job, resolved target task) cooldown, e.g. "5m", "1h". */
  cooldown?: string | undefined
}

export type JobTrigger = ScheduleTrigger | EventTrigger

export type JobTriggerKind = JobTrigger['kind']

export type ValidateJobTriggerResult =
  | { valid: true; trigger: JobTrigger }
  | { valid: false; errors: string[] }

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

const EVENT_MATCH_KEYS = new Set([
  'event',
  'subject',
  'transition',
  'project_scope_id',
  'container_path',
  'labels',
  'kind',
  'origin',
  'payload',
])

const ORIGIN_KINDS = new Set(['human', 'agent', 'system'])
const SOURCE_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/
const PAYLOAD_PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,7}$/
const FORBIDDEN_PAYLOAD_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function validateEventOrigin(value: unknown, errors: string[]): EventOriginMatch | undefined {
  if (!isRecord(value)) {
    errors.push('trigger.match.origin must be an object')
    return undefined
  }
  const origin: EventOriginMatch = {}
  if (value['actor'] !== undefined) {
    const actor = value['actor']
    if (typeof actor === 'string') {
      origin.actor = actor
    } else if (isStringArray(actor) && actor.length > 0) {
      origin.actor = actor
    } else {
      errors.push('trigger.match.origin.actor must be a non-empty string or string[]')
    }
  }
  if (value['kind'] !== undefined) {
    if (typeof value['kind'] === 'string' && ORIGIN_KINDS.has(value['kind'])) {
      origin.kind = value['kind'] as EventOriginMatch['kind']
    } else {
      errors.push("trigger.match.origin.kind must be 'human', 'agent', or 'system'")
    }
  }
  return origin
}

function validateEventSubject(value: unknown, errors: string[]): EventSubjectMatch | undefined {
  if (!isRecord(value)) {
    errors.push('trigger.match.subject must be an object')
    return undefined
  }
  const subject: EventSubjectMatch = {}
  for (const key of Object.keys(value)) {
    if (key !== 'type') {
      errors.push(`trigger.match.subject has unknown key: ${key}`)
    }
  }
  if (value['type'] !== undefined) {
    const type = value['type']
    if (typeof type === 'string') {
      subject.type = type
    } else if (isStringArray(type) && type.length > 0) {
      subject.type = type
    } else {
      errors.push('trigger.match.subject.type must be a non-empty string or string[]')
    }
  }
  return subject
}

function validatePayloadPath(path: string, errors: string[]): boolean {
  if (!PAYLOAD_PATH_PATTERN.test(path)) {
    errors.push(`trigger.match.payload has invalid path: ${path}`)
    return false
  }
  if (path.split('.').some((segment) => FORBIDDEN_PAYLOAD_SEGMENTS.has(segment))) {
    errors.push(`trigger.match.payload has forbidden path segment: ${path}`)
    return false
  }
  return true
}

function validatePayloadPredicate(
  path: string,
  value: unknown,
  errors: string[]
): PayloadPathPredicate | undefined {
  if (!isRecord(value)) {
    errors.push(`trigger.match.payload.${path} must be an object`)
    return undefined
  }
  const predicate: PayloadPathPredicate = {}
  for (const key of Object.keys(value)) {
    if (key !== 'eq' && key !== 'anyOf' && key !== 'exists') {
      errors.push(`trigger.match.payload.${path} has unknown key: ${key}`)
    }
  }
  if (value['eq'] !== undefined) {
    if (isJsonScalar(value['eq'])) {
      predicate.eq = value['eq']
    } else {
      errors.push(`trigger.match.payload.${path}.eq must be a JSON scalar`)
    }
  }
  if (value['anyOf'] !== undefined) {
    if (
      Array.isArray(value['anyOf']) &&
      value['anyOf'].length > 0 &&
      value['anyOf'].every(isJsonScalar)
    ) {
      predicate.anyOf = value['anyOf']
    } else {
      errors.push(`trigger.match.payload.${path}.anyOf must be a non-empty JSON scalar[]`)
    }
  }
  if (value['exists'] !== undefined) {
    if (typeof value['exists'] === 'boolean') {
      predicate.exists = value['exists']
    } else {
      errors.push(`trigger.match.payload.${path}.exists must be a boolean`)
    }
  }
  if (
    predicate.eq === undefined &&
    predicate.anyOf === undefined &&
    predicate.exists === undefined
  ) {
    errors.push(`trigger.match.payload.${path} must declare eq, anyOf, or exists`)
  }
  return predicate
}

function validateEventMatch(value: unknown, errors: string[]): EventMatch | undefined {
  if (!isRecord(value)) {
    errors.push('trigger.match must be an object')
    return undefined
  }

  for (const key of Object.keys(value)) {
    if (!EVENT_MATCH_KEYS.has(key)) {
      errors.push(`trigger.match has unknown key: ${key}`)
    }
  }

  const match: EventMatch = {}

  if (value['event'] !== undefined) {
    const event = value['event']
    if (typeof event === 'string') {
      match.event = event
    } else if (isStringArray(event) && event.length > 0) {
      match.event = event
    } else {
      errors.push('trigger.match.event must be a non-empty string or string[]')
    }
  }

  if (value['subject'] !== undefined) {
    const subject = validateEventSubject(value['subject'], errors)
    if (subject !== undefined) {
      match.subject = subject
    }
  }

  if (value['transition'] !== undefined) {
    const transition = value['transition']
    if (!isRecord(transition)) {
      errors.push('trigger.match.transition must be an object')
    } else {
      const from = transition['from']
      const to = transition['to']
      if (from !== undefined && from !== null && typeof from !== 'string') {
        errors.push('trigger.match.transition.from must be a string, null, or omitted')
      }
      if (to !== undefined && typeof to !== 'string') {
        errors.push('trigger.match.transition.to must be a string or omitted')
      }
      match.transition = {
        ...(from !== undefined ? { from: from as string | null } : {}),
        ...(typeof to === 'string' ? { to } : {}),
      }
    }
  }

  if (value['project_scope_id'] !== undefined) {
    if (typeof value['project_scope_id'] === 'string') {
      match.project_scope_id = value['project_scope_id']
    } else {
      errors.push('trigger.match.project_scope_id must be a string')
    }
  }

  if (value['container_path'] !== undefined) {
    if (typeof value['container_path'] === 'string') {
      match.container_path = value['container_path']
    } else {
      errors.push('trigger.match.container_path must be a string')
    }
  }

  if (value['labels'] !== undefined) {
    if (isStringArray(value['labels'])) {
      match.labels = value['labels']
    } else {
      errors.push('trigger.match.labels must be a string[]')
    }
  }

  if (value['kind'] !== undefined) {
    if (typeof value['kind'] === 'string') {
      match.kind = value['kind']
    } else {
      errors.push('trigger.match.kind must be a string')
    }
  }

  if (value['origin'] !== undefined) {
    const origin = validateEventOrigin(value['origin'], errors)
    if (origin !== undefined) {
      match.origin = origin
    }
  }

  if (value['payload'] !== undefined) {
    const payload = value['payload']
    if (!isRecord(payload)) {
      errors.push('trigger.match.payload must be an object')
    } else {
      const predicates: Record<string, PayloadPathPredicate> = {}
      for (const [path, predicateValue] of Object.entries(payload)) {
        if (!validatePayloadPath(path, errors)) {
          continue
        }
        const predicate = validatePayloadPredicate(path, predicateValue, errors)
        if (predicate !== undefined) {
          predicates[path] = predicate
        }
      }
      match.payload = predicates
    }
  }

  return match
}

/**
 * Validate an untrusted trigger blob into a typed JobTrigger. Returns the parsed
 * trigger or a list of human-readable errors. Note: cron *value* validity is
 * intentionally NOT checked here (the schedule store layer owns cron validation,
 * matching the pre-existing create/patch flow); this validates shape + discriminant.
 */
export function validateJobTrigger(value: unknown): ValidateJobTriggerResult {
  const errors: string[] = []
  if (!isRecord(value)) {
    return { valid: false, errors: ['trigger must be an object'] }
  }

  const kind = value['kind']
  if (kind === 'schedule') {
    const cron = value['cron']
    if (typeof cron !== 'string' || cron.trim().length === 0) {
      errors.push('trigger.cron must be a non-empty string for schedule triggers')
    }
    const trigger: ScheduleTrigger = {
      kind: 'schedule',
      cron: typeof cron === 'string' ? cron : '',
      ...(typeof value['windowStart'] === 'string' ? { windowStart: value['windowStart'] } : {}),
      ...(typeof value['windowEnd'] === 'string' ? { windowEnd: value['windowEnd'] } : {}),
      ...(typeof value['windowMinutes'] === 'number'
        ? { windowMinutes: value['windowMinutes'] }
        : {}),
      ...(value['catchUp'] === 'none' || value['catchUp'] === 'one'
        ? { catchUp: value['catchUp'] }
        : {}),
    }
    if (
      value['catchUp'] !== undefined &&
      value['catchUp'] !== 'none' &&
      value['catchUp'] !== 'one'
    ) {
      errors.push("trigger.catchUp must be 'none' or 'one' for schedule triggers")
    }
    return errors.length === 0 ? { valid: true, trigger } : { valid: false, errors }
  }

  if (kind === 'event') {
    const source = value['source']
    if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
      errors.push('trigger.source must match /^[a-z][a-z0-9._-]{0,79}$/ for event triggers')
    }
    const match = validateEventMatch(value['match'], errors)

    let originPolicy: OriginPolicy | undefined
    if (value['originPolicy'] !== undefined) {
      const raw = value['originPolicy']
      if (
        isRecord(raw) &&
        (raw['agent'] === 'deny' || raw['agent'] === 'deny-self' || raw['agent'] === 'allow')
      ) {
        originPolicy = { agent: raw['agent'] }
      } else {
        errors.push("trigger.originPolicy.agent must be 'deny', 'deny-self', or 'allow'")
      }
    }

    let cooldown: string | undefined
    if (value['cooldown'] !== undefined) {
      if (
        typeof value['cooldown'] === 'string' &&
        parseDurationToMs(value['cooldown']) !== undefined
      ) {
        cooldown = value['cooldown']
      } else {
        errors.push('trigger.cooldown must be a duration string like "5m" or "1h"')
      }
    }

    if (errors.length > 0 || match === undefined) {
      return { valid: false, errors }
    }
    const trigger: EventTrigger = {
      kind: 'event',
      source: typeof source === 'string' ? source : '',
      match,
      ...(originPolicy !== undefined ? { originPolicy } : {}),
      ...(cooldown !== undefined ? { cooldown } : {}),
    }
    return { valid: true, trigger }
  }

  return {
    valid: false,
    errors: [`trigger.kind must be 'schedule' or 'event' (got ${String(kind)})`],
  }
}

/**
 * Parse a duration string ("5m", "1h", "30s", "90") into milliseconds.
 * Returns undefined when the value is not a recognizable duration.
 */
export function parseDurationToMs(value: string): number | undefined {
  const trimmed = value.trim()
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(trimmed)
  if (match === null) {
    return undefined
  }
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) {
    return undefined
  }
  switch (match[2]) {
    case 'ms':
      return amount
    case 's':
      return amount * 1_000
    case 'm':
    case undefined:
      return amount * 60_000
    case 'h':
      return amount * 3_600_000
    case 'd':
      return amount * 86_400_000
    default:
      return undefined
  }
}
