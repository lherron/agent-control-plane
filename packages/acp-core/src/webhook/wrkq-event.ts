/**
 * wrkq webhook payload v2 (schema_version: 2).
 *
 * This is the contract ACP ingests at POST /v1/webhooks/wrkq. The shape is the
 * authority defined by wrkq T-01985 (comment C-03656). Only the fields ACP
 * actually consumes for matching / templating are typed precisely; the rest of
 * the durable payload is preserved verbatim in the inbox for audit/replay.
 */

import { isRecord } from '../internal/guards.js'

export type WrkqWebhookOrigin = {
  /** "human:<slug>" | "agent:<slug>" | "system:<slug>" | "system" */
  actor: string
  run_id?: string | null | undefined
  via?: string | undefined
}

export type WrkqWebhookTransition = {
  from?: string | null | undefined
  to?: string | undefined
}

export type WrkqWebhookCommentEnrichment = {
  id?: string | undefined
  author?: string | undefined
  preview?: string | undefined
  body?: string | undefined
  [key: string]: unknown
}

export type WrkqWebhookMoveEnrichment = {
  from_container_path?: string | undefined
  to_container_path?: string | undefined
  [key: string]: unknown
}

export type WrkqWebhookArchiveEnrichment = {
  prior_state?: string | undefined
  prior_container_path?: string | undefined
  reason?: string | undefined
  note?: string | undefined
  [key: string]: unknown
}

export type WrkqWebhookWorkflowStateSummary = {
  status?: string | undefined
  phase?: string | undefined
  [key: string]: unknown
}

export type WrkqWebhookWorkflowEnrichment = {
  instance_id?: string | undefined
  template?: string | Record<string, unknown> | undefined
  template_id?: string | undefined
  template_version?: string | number | undefined
  template_hash?: string | undefined
  state?: WrkqWebhookWorkflowStateSummary | undefined
  status?: string | undefined
  phase?: string | undefined
  roles?: Record<string, string> | undefined
  transition?: string | undefined
  action?: string | undefined
  outcome?: string | undefined
  run_id?: string | undefined
  action_run_id?: string | undefined
  from?: string | WrkqWebhookWorkflowStateSummary | undefined
  to?: string | WrkqWebhookWorkflowStateSummary | undefined
  observed_revision?: number | undefined
  next_revision?: number | undefined
  next_actions?: string[] | undefined
  blocked_obligations?: Record<string, unknown>[] | undefined
  checks?: Record<string, unknown>[] | undefined
  [key: string]: unknown
}

/** The subset of the v2 payload ACP matches/templates against, plus passthrough. */
export type WrkqWebhookEvent = {
  schema_version: number
  event_id: string
  event_seq: number
  event: string
  occurred_at?: string | undefined
  origin?: WrkqWebhookOrigin | undefined

  ticket_id?: string | undefined
  ticket_uuid?: string | undefined
  project_id?: string | undefined
  project_uuid?: string | undefined
  project_scope_id?: string | undefined

  transition?: WrkqWebhookTransition | null | undefined
  changed?: string[] | undefined
  changes?: Record<string, unknown> | undefined

  comment?: WrkqWebhookCommentEnrichment | undefined
  move?: WrkqWebhookMoveEnrichment | undefined
  archive?: WrkqWebhookArchiveEnrichment | undefined
  workflow?: WrkqWebhookWorkflowEnrichment | undefined

  title?: string | undefined
  slug?: string | undefined
  container_path?: string | undefined
  labels?: string[] | undefined

  state?: string | undefined
  kind?: string | undefined

  /** Anything else from the payload, kept for audit/passthrough. */
  [key: string]: unknown
}

export type ParseWrkqWebhookEventResult =
  | { ok: true; event: WrkqWebhookEvent }
  | { ok: false; error: string }

const SUPPORTED_SCHEMA_VERSION = 2

function validateStringField(
  object: Record<string, unknown>,
  field: string,
  options: { optional?: boolean; nonEmpty?: boolean } = {}
): string | undefined {
  const value = object[field]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    return `${field} must be a string when present`
  }
  if (options.nonEmpty === true && value.trim().length === 0) {
    return `${field} must be non-empty when present`
  }
  return undefined
}

function validateStringOrNumberField(
  object: Record<string, unknown>,
  field: string
): string | undefined {
  const value = object[field]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return `${field} must be a string or number when present`
  }
  return undefined
}

function validateComment(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'comment must be an object when present'
  }
  return (
    validateStringField(value, 'id', { nonEmpty: true }) ??
    validateStringField(value, 'author', { nonEmpty: true }) ??
    validateStringField(value, 'preview') ??
    validateStringField(value, 'body')
  )
}

function validateMove(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'move must be an object when present'
  }
  return (
    validateStringField(value, 'from_container_path', { nonEmpty: true }) ??
    validateStringField(value, 'to_container_path', { nonEmpty: true })
  )
}

function validateArchive(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'archive must be an object when present'
  }
  return (
    validateStringField(value, 'prior_state', { nonEmpty: true }) ??
    validateStringField(value, 'prior_container_path', { nonEmpty: true }) ??
    validateStringField(value, 'reason') ??
    validateStringField(value, 'note')
  )
}

function validateStateSummary(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || typeof value === 'string') {
    return undefined
  }
  if (!isRecord(value)) {
    return `${field} must be a string or object when present`
  }
  return validateStringField(value, 'status') ?? validateStringField(value, 'phase')
}

function validateStringArray(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return `${field} must be a string array when present`
  }
  return undefined
}

function validateRoles(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'workflow.roles must be an object when present'
  }
  for (const [role, actor] of Object.entries(value)) {
    if (typeof actor !== 'string') {
      return `workflow.roles.${role} must be a string`
    }
  }
  return undefined
}

function validateCompactObjectArray(
  value: unknown,
  field: string,
  scalarFields: readonly string[]
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    return `${field} must be an array when present`
  }
  for (const item of value) {
    if (!isRecord(item)) {
      return `${field} entries must be objects`
    }
    for (const scalarField of scalarFields) {
      const candidate = item[scalarField]
      if (
        candidate !== undefined &&
        candidate !== null &&
        typeof candidate !== 'string' &&
        typeof candidate !== 'number' &&
        typeof candidate !== 'boolean'
      ) {
        return `${field}.${scalarField} must be a scalar when present`
      }
    }
  }
  return undefined
}

function validateWorkflow(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'workflow must be an object when present'
  }
  const template = value['template']
  if (
    template !== undefined &&
    template !== null &&
    typeof template !== 'string' &&
    !isRecord(template)
  ) {
    return 'workflow.template must be a string or object when present'
  }
  const observedRevision = value['observed_revision']
  if (
    observedRevision !== undefined &&
    (typeof observedRevision !== 'number' || !Number.isFinite(observedRevision))
  ) {
    return 'workflow.observed_revision must be a finite number when present'
  }
  const nextRevision = value['next_revision']
  if (
    nextRevision !== undefined &&
    (typeof nextRevision !== 'number' || !Number.isFinite(nextRevision))
  ) {
    return 'workflow.next_revision must be a finite number when present'
  }
  return (
    validateStringField(value, 'instance_id', { nonEmpty: true }) ??
    validateStringOrNumberField(value, 'template_version') ??
    validateStringField(value, 'template_id', { nonEmpty: true }) ??
    validateStringField(value, 'template_hash', { nonEmpty: true }) ??
    validateStateSummary(value['state'], 'workflow.state') ??
    validateStringField(value, 'status') ??
    validateStringField(value, 'phase') ??
    validateRoles(value['roles']) ??
    validateStringField(value, 'transition') ??
    validateStringField(value, 'action') ??
    validateStringField(value, 'outcome') ??
    validateStringField(value, 'run_id') ??
    validateStringField(value, 'action_run_id') ??
    validateStateSummary(value['from'], 'workflow.from') ??
    validateStateSummary(value['to'], 'workflow.to') ??
    validateStringArray(value['next_actions'], 'workflow.next_actions') ??
    validateCompactObjectArray(value['blocked_obligations'], 'workflow.blocked_obligations', [
      'id',
      'label',
      'role',
      'status',
    ]) ??
    validateCompactObjectArray(value['checks'], 'workflow.checks', [
      'id',
      'label',
      'status',
      'passed',
      'failed',
      'total',
    ])
  )
}

function validateChanges(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  return isRecord(value) ? undefined : 'changes must be an object when present'
}

/**
 * Validate just enough of a wrkq webhook body to durably ingest it: the schema
 * version we understand and the durable identity (event_id, event_seq, event).
 * Everything else is preserved as-is. Fail-closed: an unknown schema version or
 * a missing identity is rejected (never silently coerced).
 */
export function parseWrkqWebhookEvent(body: unknown): ParseWrkqWebhookEventResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'webhook body must be a JSON object' }
  }

  const schemaVersion = body['schema_version']
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `unsupported schema_version: ${String(schemaVersion)} (expected ${SUPPORTED_SCHEMA_VERSION})`,
    }
  }

  const eventId = body['event_id']
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return { ok: false, error: 'event_id is required' }
  }

  const eventSeq = body['event_seq']
  if (typeof eventSeq !== 'number' || !Number.isFinite(eventSeq)) {
    return { ok: false, error: 'event_seq must be a finite number' }
  }

  const event = body['event']
  if (typeof event !== 'string' || event.trim().length === 0) {
    return { ok: false, error: 'event is required' }
  }

  const enrichmentError =
    validateComment(body['comment']) ??
    validateMove(body['move']) ??
    validateArchive(body['archive']) ??
    validateWorkflow(body['workflow']) ??
    validateChanges(body['changes'])
  if (enrichmentError !== undefined) {
    return { ok: false, error: enrichmentError }
  }

  return { ok: true, event: body as WrkqWebhookEvent }
}
