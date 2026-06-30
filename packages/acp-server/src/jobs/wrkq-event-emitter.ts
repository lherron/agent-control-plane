import type { AdminStore } from 'acp-admin-store'
import type { AcpWebhookEvent } from 'acp-core'

/**
 * ACP-layer wrkq/wrkf lifecycle telemetry emitter (T-05270).
 *
 * INVARIANT (per daedalus ruling msg #10844): wrkq/wrkf own authoritative task
 * and workflow state, and the wrkq webhook ingest commits BEFORE ACP observes
 * it. `systemEvents` is an IMMUTABLE OBSERVER PROJECTION — emission never mutates
 * wrkq state, jobs-inbox state, or the webhook response contract. A failed,
 * duplicate, or slow append is dropped (optionally logged via `onError`); it can
 * never roll anything back. Exactly-once is enforced against the systemEvents
 * store itself (`existsWithPayloadField` on the canonical source-qualified id),
 * so webhook replays and double-delivery cannot double-append.
 *
 * Only the explicit allowlist below produces a system-event / Discord card.
 * Unknown wrkq event names stay ingested for the jobs inbox but emit nothing
 * here, until the table and a renderer are extended.
 */

/**
 * wrkq/wrkf webhook event name -> system-event kind. The kind family follows the
 * DOMAIN (wrkq task vs wrkf workflow), not the transport source (all arrive under
 * source:"wrkq"). This is a closed allowlist by design (daedalus condition 3).
 */
const KIND_BY_EVENT: Readonly<Record<string, string>> = {
  created: 'wrkq.created',
  updated: 'wrkq.updated',
  moved: 'wrkq.moved',
  archived: 'wrkq.archived',
  purged: 'wrkq.purged',
  comment_added: 'wrkq.comment_added',
  workflow_attached: 'wrkf.workflow_attached',
  workflow_transitioned: 'wrkf.workflow_transitioned',
}

/** System-event payload field carrying the canonical source-qualified identity
 * (`source:event_id`). The idempotency guard keys on this, never a naked id. */
export const CANONICAL_EVENT_ID_FIELD = 'canonicalEventId'

/** Fields from the wrkq v2 payload carried verbatim into the system event so the
 * Discord card builder can render without touching wrkq authority stores. */
const CARRIED_FIELDS: readonly string[] = [
  'ticket_id',
  'ticket_uuid',
  'slug',
  'title',
  'state',
  'kind',
  'container_path',
  'labels',
  'transition',
  'changed',
  'origin',
  'subject',
  'project_id',
  'project_scope_id',
]

const UPDATED_CHANGE_FIELDS = new Set([
  'state',
  'title',
  'labels',
  'priority',
  'due_at',
  'start_at',
  'container_path',
  'slug',
  'kind',
])

const PREVIEW_MAX = 240
const COMPACT_LABEL_MAX = 80
const COMPACT_ARRAY_MAX = 5

export type WrkqEventEmitter = {
  /**
   * Project a recognized wrkq/wrkf webhook event into systemEvents. Observer
   * only: never throws into the caller, and is a no-op for unrecognized event
   * names. Idempotent across webhook replays.
   */
  emit(event: AcpWebhookEvent): void
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compactString(value: unknown, max = PREVIEW_MAX): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const compacted = stripControlCharacters(value).replace(/\s+/g, ' ').trim()
  if (compacted.length === 0) {
    return undefined
  }
  return compacted.length > max ? compacted.slice(0, max) : compacted
}

function stripControlCharacters(value: string): string {
  let output = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    output += code < 32 || code === 127 ? ' ' : char
  }
  return output
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return compactString(value)
}

function compactStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const values = value
    .slice(0, COMPACT_ARRAY_MAX)
    .map((item) => compactString(item, COMPACT_LABEL_MAX))
    .filter((item): item is string => item !== undefined)
  return values.length > 0 ? values : undefined
}

function changeValue(value: unknown): string | number | boolean | null | string[] | undefined {
  const primitive = scalar(value)
  if (primitive !== undefined) {
    return primitive
  }
  return compactStringArray(value)
}

function nestedRecord(
  src: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = src[key]
  return isRecord(value) ? value : undefined
}

function changeEndpoint(
  src: Record<string, unknown>,
  field: string,
  endpoint: 'from' | 'to'
): unknown {
  const changes = nestedRecord(src, 'changes')
  const summary = changes?.[field]
  return isRecord(summary) ? summary[endpoint] : undefined
}

function projectChanges(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const changes = nestedRecord(src, 'changes')
  if (changes === undefined) {
    return undefined
  }
  const projected: Record<string, unknown> = {}
  for (const [field, summary] of Object.entries(changes)) {
    if (!UPDATED_CHANGE_FIELDS.has(field) || !isRecord(summary)) {
      continue
    }
    const from = changeValue(summary['from'])
    const to = changeValue(summary['to'])
    const item: Record<string, unknown> = {}
    if (from !== undefined) {
      item['from'] = from
    }
    if (to !== undefined) {
      item['to'] = to
    }
    if (Object.keys(item).length > 0) {
      projected[field] = item
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

function projectComment(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const comment = nestedRecord(src, 'comment')
  const id = compactString(comment?.['id']) ?? compactString(changeEndpoint(src, 'comments', 'to'))
  if (id === undefined) {
    return undefined
  }
  const projected: Record<string, unknown> = { id }
  const author = compactString(comment?.['author'])
  const preview = compactString(comment?.['preview'])
  if (author !== undefined) {
    projected['author'] = author
  }
  if (preview !== undefined) {
    projected['preview'] = preview
  }
  return projected
}

function projectMove(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const move = nestedRecord(src, 'move')
  const from =
    compactString(move?.['from_container_path']) ??
    compactString(changeEndpoint(src, 'container_path', 'from'))
  const to =
    compactString(move?.['to_container_path']) ??
    compactString(changeEndpoint(src, 'container_path', 'to'))
  return from !== undefined && to !== undefined
    ? { from_container_path: from, to_container_path: to }
    : undefined
}

function projectArchive(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const archive = nestedRecord(src, 'archive')
  const transition = nestedRecord(src, 'transition')
  const priorState = compactString(archive?.['prior_state']) ?? compactString(transition?.['from'])
  const priorContainerPath =
    compactString(archive?.['prior_container_path']) ?? compactString(src['container_path'])
  const reason = compactString(archive?.['reason'])
  const note = compactString(archive?.['note'])
  const projected: Record<string, unknown> = {}
  if (priorState !== undefined) {
    projected['prior_state'] = priorState
  }
  if (priorContainerPath !== undefined) {
    projected['prior_container_path'] = priorContainerPath
  }
  if (reason !== undefined) {
    projected['reason'] = reason
  }
  if (note !== undefined) {
    projected['note'] = note
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

function compactRoles(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const roles: Record<string, string> = {}
  for (const [role, actor] of Object.entries(value).slice(0, COMPACT_ARRAY_MAX)) {
    const compactRole = compactString(role, COMPACT_LABEL_MAX)
    const compactActor = compactString(actor, COMPACT_LABEL_MAX)
    if (compactRole !== undefined && compactActor !== undefined) {
      roles[compactRole] = compactActor
    }
  }
  return Object.keys(roles).length > 0 ? roles : undefined
}

function workflowState(value: unknown): Record<string, string> | undefined {
  if (typeof value === 'string') {
    const status = compactString(value, COMPACT_LABEL_MAX)
    return status === undefined ? undefined : { status }
  }
  if (!isRecord(value)) {
    return undefined
  }
  const status = compactString(value['status'], COMPACT_LABEL_MAX)
  const phase = compactString(value['phase'], COMPACT_LABEL_MAX)
  const projected: Record<string, string> = {}
  if (status !== undefined) {
    projected['status'] = status
  }
  if (phase !== undefined) {
    projected['phase'] = phase
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

function workflowTemplate(value: unknown): string | Record<string, string | number> | undefined {
  const compact = compactString(value)
  if (compact !== undefined) {
    return compact
  }
  if (!isRecord(value)) {
    return undefined
  }
  const projected: Record<string, string | number> = {}
  for (const field of ['id', 'version', 'hash']) {
    const candidate = value[field]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      projected[field] = candidate
    } else {
      const compactCandidate = compactString(candidate)
      if (compactCandidate !== undefined) {
        projected[field] = compactCandidate
      }
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

function compactObjectArray(
  value: unknown,
  fields: readonly string[]
): Record<string, string | number | boolean>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const projected: Record<string, string | number | boolean>[] = []
  for (const item of value) {
    if (projected.length >= COMPACT_ARRAY_MAX) {
      break
    }
    if (!isRecord(item)) {
      continue
    }
    const compactItem: Record<string, string | number | boolean> = {}
    for (const field of fields) {
      const candidate = item[field]
      if (typeof candidate === 'number' || typeof candidate === 'boolean') {
        compactItem[field] = candidate
        continue
      }
      const compactCandidate = compactString(candidate, COMPACT_LABEL_MAX)
      if (compactCandidate !== undefined) {
        compactItem[field] = compactCandidate
      }
    }
    if (Object.keys(compactItem).length > 0) {
      projected.push(compactItem)
    }
  }
  return projected.length > 0 ? projected : undefined
}

function compactRequiredStringObjectArray(
  value: unknown,
  fields: readonly string[]
): Record<string, string>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const projected: Record<string, string>[] = []
  for (const item of value) {
    if (projected.length >= COMPACT_ARRAY_MAX) {
      break
    }
    if (!isRecord(item)) {
      continue
    }
    const compactItem: Record<string, string> = {}
    for (const field of fields) {
      const compactCandidate = compactString(item[field], COMPACT_LABEL_MAX)
      if (compactCandidate === undefined) {
        continue
      }
      compactItem[field] = compactCandidate
    }
    if (fields.every((field) => compactItem[field] !== undefined)) {
      projected.push(compactItem)
    }
  }
  return projected.length > 0 ? projected : undefined
}

function assignString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  field: string,
  max = PREVIEW_MAX
): void {
  const value = compactString(source[field], max)
  if (value !== undefined) {
    target[field] = value
  }
}

function assignNumber(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  field: string
): void {
  const value = source[field]
  if (typeof value === 'number' && Number.isFinite(value)) {
    target[field] = value
  }
}

function projectWorkflow(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const workflow = nestedRecord(src, 'workflow')
  if (workflow === undefined) {
    return undefined
  }
  const projected: Record<string, unknown> = {}
  for (const field of [
    'instance_id',
    'template_id',
    'template_hash',
    'transition',
    'action',
    'outcome',
    'run_id',
    'action_run_id',
  ]) {
    assignString(projected, workflow, field)
  }
  const templateVersion = workflow['template_version']
  if (typeof templateVersion === 'number' && Number.isFinite(templateVersion)) {
    projected['template_version'] = templateVersion
  } else {
    assignString(projected, workflow, 'template_version')
  }
  const template = workflowTemplate(workflow['template'])
  if (template !== undefined) {
    projected['template'] = template
  }
  const state = workflowState(workflow['state'])
  const status = compactString(workflow['status'], COMPACT_LABEL_MAX) ?? state?.['status']
  const phase = compactString(workflow['phase'], COMPACT_LABEL_MAX) ?? state?.['phase']
  if (status !== undefined) {
    projected['status'] = status
  }
  if (phase !== undefined) {
    projected['phase'] = phase
  }
  const roles = compactRoles(workflow['roles'])
  if (roles !== undefined) {
    projected['roles'] = roles
  }
  const from = workflowState(workflow['from'])
  const to = workflowState(workflow['to'])
  if (from !== undefined) {
    projected['from'] = from
  }
  if (to !== undefined) {
    projected['to'] = to
  }
  assignNumber(projected, workflow, 'observed_revision')
  assignNumber(projected, workflow, 'next_revision')
  const nextActions = compactStringArray(workflow['next_actions'])
  if (nextActions !== undefined) {
    projected['next_actions'] = nextActions
  }
  const blockedObligations = compactRequiredStringObjectArray(workflow['blocked_obligations'], [
    'id',
    'label',
    'role',
    'status',
  ])
  if (blockedObligations !== undefined) {
    projected['blocked_obligations'] = blockedObligations
  }
  const checks = compactObjectArray(workflow['checks'], [
    'id',
    'label',
    'status',
    'passed',
    'failed',
    'total',
  ])
  if (checks !== undefined) {
    projected['checks'] = checks
  }
  for (const field of ['revision', 'context_hash', 'task_doc_hash']) {
    const value = workflow[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      projected[field] = value
      continue
    }
    assignString(projected, workflow, field)
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

export function mapEventKind(event: string): string | undefined {
  return KIND_BY_EVENT[event]
}

export function createWrkqEventEmitter(input: {
  systemEvents: AdminStore['systemEvents']
  now?: (() => Date) | undefined
  /** Best-effort observability hook for dropped appends. Never re-thrown. */
  onError?: ((err: unknown, event: AcpWebhookEvent) => void) | undefined
}): WrkqEventEmitter {
  const now = input.now ?? (() => new Date())

  function buildPayload(event: AcpWebhookEvent, canonicalEventId: string): Record<string, unknown> {
    const src = event.payload as Record<string, unknown>
    const projectId =
      asNonEmptyString(src['project_scope_id']) ?? asNonEmptyString(src['project_id']) ?? 'wrkq'
    const payload: Record<string, unknown> = {
      [CANONICAL_EVENT_ID_FIELD]: canonicalEventId,
      sourceEventId: event.event_id,
      source: event.source,
      event: event.event,
      projectId,
    }
    if (event.origin !== undefined) {
      payload['origin'] = event.origin
    }
    for (const key of CARRIED_FIELDS) {
      if (src[key] !== undefined) {
        payload[key] = src[key]
      }
    }
    if (event.event === 'comment_added') {
      const comment = projectComment(src)
      if (comment !== undefined) {
        payload['comment'] = comment
      }
    }
    if (event.event === 'moved') {
      const move = projectMove(src)
      if (move !== undefined) {
        payload['move'] = move
      }
    }
    if (event.event === 'archived' || event.event === 'purged') {
      const archive = projectArchive(src)
      if (archive !== undefined) {
        payload['archive'] = archive
      }
    }
    if (event.event === 'updated') {
      const changes = projectChanges(src)
      if (changes !== undefined) {
        payload['changes'] = changes
      }
    }
    if (event.event === 'workflow_attached' || event.event === 'workflow_transitioned') {
      const workflow = projectWorkflow(src)
      if (workflow !== undefined) {
        payload['workflow'] = workflow
      }
    }
    return payload
  }

  function emit(event: AcpWebhookEvent): void {
    try {
      const kind = mapEventKind(event.event)
      if (kind === undefined) {
        return
      }
      const canonicalEventId = event.canonical_event_id
      if (
        input.systemEvents.existsWithPayloadField({
          kind,
          field: CANONICAL_EVENT_ID_FIELD,
          value: canonicalEventId,
        })
      ) {
        return
      }
      const payload = buildPayload(event, canonicalEventId)
      input.systemEvents.append({
        projectId: payload['projectId'] as string,
        kind,
        payload,
        occurredAt: asNonEmptyString(event.occurred_at) ?? now().toISOString(),
        recordedAt: now().toISOString(),
      })
    } catch (err) {
      input.onError?.(err, event)
    }
  }

  return { emit }
}
