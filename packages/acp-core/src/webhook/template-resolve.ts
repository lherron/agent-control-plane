import { normalizeSessionRef } from 'agent-scope'

import type { AcpWebhookEvent } from './acp-event.js'

/** Cap on untrusted payload fields interpolated into prompt CONTENT. */
const CONTENT_VALUE_CAP = 500
const CONTENT_FIELD_CAP = 8_000

export type ResolvedEventAction = {
  scopeRef: string
  laneRef: string
  input: Record<string, unknown>
  /** Deterministic target key used by the cooldown backstop. */
  targetKey: string
}

export type ResolveEventActionResult =
  | { ok: true; resolved: ResolvedEventAction }
  | { ok: false; error: string }

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

function cap(value: string): string {
  return value.length > CONTENT_VALUE_CAP ? value.slice(0, CONTENT_VALUE_CAP) : value
}

function capField(value: string): string {
  return value.length > CONTENT_FIELD_CAP ? value.slice(0, CONTENT_FIELD_CAP) : value
}

function sanitize(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
      out += ch
    }
  }
  return out
}

function scalarToContent(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return cap(sanitize(String(value)))
  }
  return cap(sanitize(JSON.stringify(value)))
}

function payloadValueAtPath(payload: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = payload
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * STRUCTURAL vars are the only variables allowed to shape a scopeRef. Allowlist
 * is intentionally source-specific. v1 allows wrkq-controlled project/task ids
 * for compatibility and denies payload-derived structural vars for other
 * sources. Generic producers can still target static scopeRef/laneRef values.
 */
function structuralVars(event: AcpWebhookEvent): Record<string, string | undefined> {
  if (event.source === 'wrkq') {
    return {
      project_scope_id:
        typeof event.payload['project_scope_id'] === 'string'
          ? event.payload['project_scope_id']
          : undefined,
      ticket_id:
        typeof event.payload['ticket_id'] === 'string' ? event.payload['ticket_id'] : undefined,
    }
  }
  return {}
}

/**
 * CONTENT vars may additionally include untrusted payload fields (title, slug,
 * container_path, labels) — capped, and only ever interpolated into prompt text,
 * never into a scopeRef / exec argv / cwd / env.
 */
function contentVars(event: AcpWebhookEvent): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {
    ...structuralVars(event),
    source: event.source,
    event: event.event,
    event_id: event.event_id,
    canonical_event_id: event.canonical_event_id,
    event_seq: String(event.event_seq),
    occurred_at: event.occurred_at,
    subject_type: event.subject?.type,
    subject_id: event.subject?.id,
    origin_actor: event.origin?.actor,
    origin_kind: event.origin?.kind,
    title: typeof event.payload['title'] === 'string' ? cap(event.payload['title']) : undefined,
    slug: typeof event.payload['slug'] === 'string' ? cap(event.payload['slug']) : undefined,
    container_path:
      typeof event.payload['container_path'] === 'string'
        ? cap(event.payload['container_path'])
        : undefined,
    labels: Array.isArray(event.payload['labels'])
      ? cap(event.payload['labels'].join(','))
      : undefined,
  }
  for (const [key, value] of Object.entries(vars)) {
    vars[key] = value === undefined ? undefined : cap(sanitize(value))
  }
  return vars
}

/**
 * Fail-closed template expansion: every `{{var}}` MUST resolve to a defined,
 * allowlisted value. An unknown variable name or an undefined value is an error
 * (never an empty string).
 */
function resolveTemplateString(
  template: string,
  vars: Record<string, string | undefined>,
  event?: AcpWebhookEvent | undefined
): { ok: true; value: string } | { ok: false; error: string } {
  let failure: string | undefined
  const value = template.replace(TEMPLATE_PATTERN, (_match, name: string) => {
    if (name.startsWith('payload.')) {
      if (event === undefined) {
        failure ??= `unknown template variable: {{${name}}}`
        return ''
      }
      const resolved = scalarToContent(
        payloadValueAtPath(event.payload, name.slice('payload.'.length))
      )
      if (resolved === undefined || resolved.length === 0) {
        failure ??= `undefined template variable: {{${name}}}`
        return ''
      }
      return resolved
    }
    if (!(name in vars)) {
      failure ??= `unknown template variable: {{${name}}}`
      return ''
    }
    const resolved = vars[name]
    if (resolved === undefined || resolved.length === 0) {
      failure ??= `undefined template variable: {{${name}}}`
      return ''
    }
    return resolved
  })
  return failure === undefined
    ? { ok: true, value: capField(value) }
    : { ok: false, error: failure }
}

function resolveInputTemplate(
  input: Record<string, unknown>,
  vars: Record<string, string | undefined>,
  event: AcpWebhookEvent
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw === 'string') {
      const resolved = resolveTemplateString(raw, vars, event)
      if (!resolved.ok) {
        return { ok: false, error: `input.${key}: ${resolved.error}` }
      }
      out[key] = resolved.value
    } else {
      out[key] = raw
    }
  }
  return { ok: true, value: out }
}

/**
 * Resolve an event-triggered job's action against a matched wrkq event,
 * fail-closed, and validate the resolved scopeRef/laneRef through agent-scope's
 * canonical SessionRef normalizer. The dispatch tail consumes ONLY this resolved
 * snapshot — never the live templated job fields.
 */
export function resolveEventAction(input: {
  scopeRefTemplate: string
  laneRefTemplate?: string | undefined
  inputTemplate: Record<string, unknown>
  event: AcpWebhookEvent
}): ResolveEventActionResult {
  const structural = structuralVars(input.event)

  const scope = resolveTemplateString(input.scopeRefTemplate, structural)
  if (!scope.ok) {
    return { ok: false, error: `scopeRef: ${scope.error}` }
  }

  const laneTemplate = input.laneRefTemplate ?? 'main'
  const lane = resolveTemplateString(laneTemplate, structural)
  if (!lane.ok) {
    return { ok: false, error: `laneRef: ${lane.error}` }
  }

  let sessionRef: ReturnType<typeof normalizeSessionRef>
  try {
    sessionRef = normalizeSessionRef({ scopeRef: scope.value, laneRef: lane.value })
  } catch (error) {
    return {
      ok: false,
      error: `resolved scopeRef is not a valid SessionRef: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const resolvedInput = resolveInputTemplate(
    input.inputTemplate,
    contentVars(input.event),
    input.event
  )
  if (!resolvedInput.ok) {
    return { ok: false, error: resolvedInput.error }
  }

  return {
    ok: true,
    resolved: {
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      input: resolvedInput.value,
      targetKey: targetKey(input.event),
    },
  }
}

function targetKey(event: AcpWebhookEvent): string {
  if (event.source === 'wrkq' && typeof event.payload['ticket_id'] === 'string') {
    return event.payload['ticket_id']
  }
  if (event.subject?.type !== undefined && event.subject.id !== undefined) {
    return `${event.subject.type}:${event.subject.id}`
  }
  return event.canonical_event_id
}
