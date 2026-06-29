import { avatarFor } from './identity.js'
import type { WebhookPayload } from './webhooks.js'

/**
 * #work-activity lifecycle cards (T-05270).
 *
 * Renders ACP `wrkq.*` (task) and `wrkf.*` (workflow) system events into Discord
 * embed cards. NON-AUTHORITATIVE observer egress: reads only the immutable
 * systemEvents projection, posts to one fixed channel, never reads wrkq/wrkf
 * authority stores or interface bindings, and a render/send failure cannot affect
 * task or workflow state.
 *
 * Design: this is a high-volume firehose (every recognized transition), so the
 * card is a LEDGER LINE, not a poster — deliberately the opposite of the heavy
 * #job-runs card. Three independent visual channels, each doing one job:
 *   - color (accent bar) encodes STATE (the thing you scan for),
 *   - the from -> to ARROW in the title is the hero (you read the motion),
 *   - the leading GLYPH encodes the event family/verb.
 * No big thumbnail, no footer — the id already lives in the title.
 */

const WRKQ_PREFIX = 'wrkq.'
const WRKF_PREFIX = 'wrkf.'

/** True for the kinds this builder renders. */
export function isWorkActivityKind(kind: string): boolean {
  return kind.startsWith(WRKQ_PREFIX) || kind.startsWith(WRKF_PREFIX)
}

export type WorkActivitySystemEvent = {
  eventId: string
  kind: string
  projectId: string
  occurredAt: string
  payload: Record<string, unknown>
}

// Accent bar = STATE semantics. Greens/reds match #job-runs for family coherence.
const COLOR_BY_STATE: Readonly<Record<string, number>> = {
  idea: 0x7c8595,
  draft: 0x7c8595,
  open: 0x7c8595,
  in_progress: 0xe0a23c,
  completed: 0x3ba55d,
  blocked: 0xed4245,
  cancelled: 0x6b7280,
  archived: 0x4b5563,
  deleted: 0x4b5563,
}
const COLOR_NEUTRAL = 0x7c8595 // slate — exists / generic update
const COLOR_COMMENT = 0xa78bfa // violet — communication, not state
const COLOR_MOVED = 0x8b9bb4 // slate-blue
const COLOR_ARCHIVED = 0x4b5563 // dim — receding
const COLOR_WF_ATTACHED = 0x14b8a6 // teal — engine engaged

const EM_DASH = '—'
const TITLE_MAX = 256
const DESCRIPTION_MAX = 4096
const FIELD_VALUE_MAX = 1024
const FOOTER_MAX = 2048
const LIST_VALUE_MAX = 220

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0
  )
  return strings.length > 0 ? strings : undefined
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function compactList(values: string[] | undefined, maxItems = 5): string | undefined {
  if (values === undefined || values.length === 0) {
    return undefined
  }
  const visible = values.slice(0, maxItems)
  const suffix = values.length > visible.length ? `, +${values.length - visible.length}` : ''
  return truncate(`${visible.join(', ')}${suffix}`, LIST_VALUE_MAX)
}

type EmbedField = { name: string; value: string; inline: boolean }

function inlineField(name: string, value: string | undefined): EmbedField | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }
  return { name, value: truncate(value, FIELD_VALUE_MAX), inline: true }
}

function blockField(name: string, value: string | undefined): EmbedField | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }
  return { name, value: truncate(value, FIELD_VALUE_MAX), inline: false }
}

function pushDefined<T>(target: T[], value: T | undefined): void {
  if (value !== undefined) {
    target.push(value)
  }
}

/** "agent:cody" -> "cody"; "system" -> "system". Used for label + avatar seed. */
function actorSlug(actor: string | undefined): string | undefined {
  if (actor === undefined) {
    return undefined
  }
  const idx = actor.indexOf(':')
  return idx === -1 ? actor : actor.slice(idx + 1)
}

/** Compact "T-id slug" subject suffix for the title. */
function subjectSuffix(payload: Record<string, unknown>): string {
  const ticket = asString(payload['ticket_id'])
  const slug = asString(payload['slug'])
  if (ticket !== undefined && slug !== undefined) {
    return `${ticket} ${slug}`
  }
  return ticket ?? slug ?? EM_DASH
}

function changedFields(payload: Record<string, unknown>): string | undefined {
  const direct = compactList(asStringArray(payload['changed']))
  if (direct !== undefined) {
    return direct
  }
  const changes = asRecord(payload['changes'])
  if (changes === undefined) {
    return undefined
  }
  return compactList(Object.keys(changes).filter((key) => key.length > 0))
}

function sourceIdentity(payload: Record<string, unknown>): string | undefined {
  const canonical = asString(payload['canonicalEventId'])
  if (canonical !== undefined) {
    return canonical
  }
  const source = asString(payload['source'])
  const sourceEventId = asString(payload['sourceEventId'])
  if (source !== undefined && sourceEventId !== undefined) {
    return `${source}:${sourceEventId}`
  }
  return undefined
}

/** Workflow state summary: "status:phase" or just "status". */
function workflowStateSummary(value: unknown): string | undefined {
  const direct = asString(value)
  if (direct !== undefined) {
    return direct
  }
  const record = asRecord(value)
  if (record === undefined) {
    return undefined
  }
  const status = asString(record['status'])
  const phase = asString(record['phase'])
  if (status === undefined) {
    return undefined
  }
  return phase !== undefined ? `${status}:${phase}` : status
}

type Rendered = { glyph: string; title: string; color: number }

function renderWrkq(kind: string, payload: Record<string, unknown>): Rendered | undefined {
  const suffix = subjectSuffix(payload)
  const transition = asRecord(payload['transition'])
  const toState = asString(transition?.['to']) ?? asString(payload['state'])
  const fromState = asString(transition?.['from'])

  switch (kind) {
    case 'wrkq.created':
      return { glyph: '✦', title: `✦ created · ${suffix}`, color: COLOR_NEUTRAL }
    case 'wrkq.updated': {
      // State transitions render the arrow as the hero; other field updates fall
      // back to a neutral "updated" line listing what changed.
      if (fromState !== undefined && toState !== undefined) {
        return {
          glyph: '◆',
          title: `◆ ${fromState} → ${toState} · ${suffix}`,
          color: COLOR_BY_STATE[toState] ?? COLOR_NEUTRAL,
        }
      }
      return { glyph: '◆', title: `◆ updated · ${suffix}`, color: COLOR_NEUTRAL }
    }
    case 'wrkq.moved':
      return { glyph: '⇄', title: `⇄ moved · ${suffix}`, color: COLOR_MOVED }
    case 'wrkq.archived':
      return { glyph: '▽', title: `▽ archived · ${suffix}`, color: COLOR_ARCHIVED }
    case 'wrkq.purged':
      return { glyph: '⌫', title: `⌫ purged · ${suffix}`, color: COLOR_ARCHIVED }
    case 'wrkq.comment_added':
      return { glyph: '❝', title: `❝ comment · ${suffix}`, color: COLOR_COMMENT }
    default:
      return undefined
  }
}

function buildWrkqFields(payload: Record<string, unknown>): EmbedField[] {
  const fields: EmbedField[] = []
  pushDefined(fields, blockField('Task', truncate(oneLine(asString(payload['title']) ?? ''), 180)))
  pushDefined(fields, inlineField('Path', asString(payload['container_path'])))
  pushDefined(fields, inlineField('Changed', changedFields(payload)))
  pushDefined(fields, inlineField('Labels', compactList(asStringArray(payload['labels']))))
  return fields
}

function renderWrkf(kind: string, payload: Record<string, unknown>): Rendered | undefined {
  const suffix = subjectSuffix(payload)
  const workflow = asRecord(payload['workflow'])

  if (kind === 'wrkf.workflow_attached') {
    const template = asString(workflow?.['template'])
    const titleSuffix = template !== undefined ? `${suffix} [${template}]` : suffix
    return { glyph: '⚙', title: `⚙ workflow attached · ${titleSuffix}`, color: COLOR_WF_ATTACHED }
  }

  if (kind === 'wrkf.workflow_transitioned') {
    const transition = asRecord(payload['transition'])
    const from =
      asString(transition?.['from']) ?? workflowStateSummary(workflow?.['from']) ?? EM_DASH
    const to = asString(transition?.['to']) ?? workflowStateSummary(workflow?.['to']) ?? EM_DASH
    const outcome = asString(workflow?.['outcome'])
    const toStatus = to.includes(':') ? to.slice(0, to.indexOf(':')) : to
    const titleSuffix = outcome !== undefined ? `${suffix} (${outcome})` : suffix
    return {
      glyph: '⟶',
      title: `⟶ ${from} → ${to} · ${titleSuffix}`,
      color: COLOR_BY_STATE[toStatus] ?? COLOR_WF_ATTACHED,
    }
  }

  return undefined
}

function workflowId(workflow: Record<string, unknown> | undefined): string | undefined {
  return asString(workflow?.['instance_id']) ?? asString(workflow?.['instanceId'])
}

function workflowTemplate(workflow: Record<string, unknown> | undefined): string | undefined {
  return (
    asString(workflow?.['template']) ??
    asString(workflow?.['template_id']) ??
    asString(workflow?.['templateId'])
  )
}

function buildWrkfFields(
  kind: string,
  payload: Record<string, unknown>,
  runId: string | undefined
): EmbedField[] {
  const fields: EmbedField[] = []
  const workflow = asRecord(payload['workflow'])
  pushDefined(fields, inlineField('Workflow', workflowId(workflow)))
  pushDefined(fields, inlineField('Template', workflowTemplate(workflow)))
  if (kind === 'wrkf.workflow_transitioned') {
    pushDefined(fields, inlineField('Transition', asString(workflow?.['transition'])))
    pushDefined(fields, inlineField('Outcome', asString(workflow?.['outcome'])))
  }
  pushDefined(fields, inlineField('Run', runId))
  return fields
}

/**
 * Build the Discord webhook payload (embed card + system identity) for a
 * wrkq/wrkf lifecycle event. Returns undefined for unrelated kinds so the caller
 * can skip them. Pure: event -> card, no I/O.
 */
export function buildWorkActivityCard(event: WorkActivitySystemEvent): WebhookPayload | undefined {
  if (!isWorkActivityKind(event.kind)) {
    return undefined
  }
  const payload = event.payload
  const family = event.kind.startsWith(WRKF_PREFIX) ? 'wrkf' : 'wrkq'

  const rendered =
    family === 'wrkf' ? renderWrkf(event.kind, payload) : renderWrkq(event.kind, payload)
  if (rendered === undefined) {
    return undefined
  }

  const origin = asRecord(payload['origin'])
  const actor = actorSlug(asString(origin?.['actor'])) ?? 'system'
  const via = asString(origin?.['via'])
  const runId = asString(origin?.['run_id'])
  const fields =
    family === 'wrkf' ? buildWrkfFields(event.kind, payload, runId) : buildWrkqFields(payload)
  const identity = sourceIdentity(payload)

  // De-emphasized one-line subtitle: who did it, via what.
  const subtitleParts = [`by ${actor}`]
  if (via !== undefined) {
    subtitleParts.push(via)
  }
  if (family === 'wrkf' && runId !== undefined) {
    subtitleParts.push(`run ${runId}`)
  }
  const description = truncate(`-# ${subtitleParts.join(' · ')}`, DESCRIPTION_MAX)

  const embed = {
    title: truncate(rendered.title, TITLE_MAX),
    description,
    color: rendered.color,
    ...(fields.length > 0 ? { fields } : {}),
    ...(identity !== undefined
      ? { footer: { text: truncate(`event ${identity}`, FOOTER_MAX) } }
      : {}),
    timestamp: event.occurredAt,
  }

  return {
    username: `${actor} · ${family}`,
    avatar_url: avatarFor(actor),
    embeds: [embed],
  }
}
