import { normalizeSessionRef } from 'agent-scope'

import type { WrkqWebhookEvent } from './wrkq-event.js'

/** Cap on untrusted payload fields interpolated into prompt CONTENT. */
const CONTENT_VALUE_CAP = 500

export type ResolvedEventAction = {
  scopeRef: string
  laneRef: string
  input: Record<string, unknown>
  /** Resolved target task id (used as the cooldown key). */
  targetTaskId: string | undefined
}

export type ResolveEventActionResult =
  | { ok: true; resolved: ResolvedEventAction }
  | { ok: false; error: string }

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

function cap(value: string): string {
  return value.length > CONTENT_VALUE_CAP ? value.slice(0, CONTENT_VALUE_CAP) : value
}

/**
 * STRUCTURAL vars are the only variables allowed to shape a scopeRef. Allowlist
 * is intentionally {project_scope_id, ticket_id} ONLY (constraint #9) — these
 * are wrkq-controlled identifiers, never free-form user text.
 */
function structuralVars(event: WrkqWebhookEvent): Record<string, string | undefined> {
  return {
    project_scope_id: event.project_scope_id,
    ticket_id: event.ticket_id,
  }
}

/**
 * CONTENT vars may additionally include untrusted payload fields (title, slug,
 * container_path, labels) — capped, and only ever interpolated into prompt text,
 * never into a scopeRef / exec argv / cwd / env.
 */
function contentVars(event: WrkqWebhookEvent): Record<string, string | undefined> {
  return {
    ...structuralVars(event),
    event: event.event,
    title: typeof event.title === 'string' ? cap(event.title) : undefined,
    slug: typeof event.slug === 'string' ? cap(event.slug) : undefined,
    container_path:
      typeof event.container_path === 'string' ? cap(event.container_path) : undefined,
    labels: Array.isArray(event.labels) ? cap(event.labels.join(',')) : undefined,
  }
}

/**
 * Fail-closed template expansion: every `{{var}}` MUST resolve to a defined,
 * allowlisted value. An unknown variable name or an undefined value is an error
 * (never an empty string).
 */
function resolveTemplateString(
  template: string,
  vars: Record<string, string | undefined>
): { ok: true; value: string } | { ok: false; error: string } {
  let failure: string | undefined
  const value = template.replace(TEMPLATE_PATTERN, (_match, name: string) => {
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
  return failure === undefined ? { ok: true, value } : { ok: false, error: failure }
}

function resolveInputTemplate(
  input: Record<string, unknown>,
  vars: Record<string, string | undefined>
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw === 'string') {
      const resolved = resolveTemplateString(raw, vars)
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
  event: WrkqWebhookEvent
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

  const resolvedInput = resolveInputTemplate(input.inputTemplate, contentVars(input.event))
  if (!resolvedInput.ok) {
    return { ok: false, error: resolvedInput.error }
  }

  return {
    ok: true,
    resolved: {
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      input: resolvedInput.value,
      targetTaskId: input.event.ticket_id,
    },
  }
}
