import { parseScopeRef } from 'agent-scope'

import { avatarFor } from './identity.js'
import { isTaskboardTaskId, taskboardTerminalFocusUrl } from './taskboard-links.js'
import type { WebhookPayload } from './webhooks.js'

/**
 * #job-runs lifecycle cards (T-05245).
 *
 * Renders ACP `job.dispatched` / `job.completed` system events into Discord embed
 * cards. This is NON-AUTHORITATIVE observer egress: it reads the immutable
 * systemEvents projection and posts to one fixed channel. It never reads interface
 * bindings, never routes, and a render/send failure cannot affect job-run state.
 */

export const JOB_DISPATCHED_EVENT = 'job.dispatched'
export const JOB_COMPLETED_EVENT = 'job.completed'

/** Minimal shape of a system event as returned by GET /v1/admin/system-events. */
export type JobLifecycleSystemEvent = {
  eventId: string
  kind: string
  projectId: string
  occurredAt: string
  payload: Record<string, unknown>
}

// Discord embed accent colors (decimal RGB).
const COLOR_STARTED = 0x5865f2 // blurple
const COLOR_SUCCEEDED = 0x3ba55d // green
const COLOR_FAILED = 0xed4245 // red

const EM_DASH = '—'
// Job descriptions are inconsistent (empty, machine-noise, or multi-sentence), so
// the card shows them only when present, collapsed to a single truncated line.
const DESCRIPTION_MAX = 100
const FIELD_VALUE_MAX = 1024

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Collapse a job description to one line and truncate for the card subtitle. */
function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > DESCRIPTION_MAX
    ? `${collapsed.slice(0, DESCRIPTION_MAX - 1)}…`
    : collapsed
}

// Discord embed description cap is 4096; the completed card renders the agent's
// markdown response here (under the subtitle).
const EMBED_DESCRIPTION_MAX = 4096

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Compact human label for the job trigger half. */
function describeTrigger(trigger: unknown): string {
  if (typeof trigger !== 'object' || trigger === null) {
    return EM_DASH
  }
  const record = trigger as Record<string, unknown>
  if (record['kind'] === 'schedule') {
    return asString(record['cron']) ?? 'schedule'
  }
  if (record['kind'] === 'event') {
    const source = asString(record['source'])
    return source !== undefined ? `event · ${source}` : 'event'
  }
  return EM_DASH
}

/** Resolve the task id for the card: explicit payload field, else parsed from the
 * scope ref. Flow/scheduled runs frequently carry it only inside the scope ref. */
function resolveTaskId(payload: Record<string, unknown>): string {
  const explicit = asString(payload['taskId'])
  if (explicit !== undefined) {
    return explicit
  }
  const scopeRef = asString(payload['scopeRef'])
  if (scopeRef !== undefined) {
    try {
      return parseScopeRef(scopeRef).taskId ?? EM_DASH
    } catch {
      return EM_DASH
    }
  }
  return EM_DASH
}

type EmbedField = { name: string; value: string; inline: boolean }

function inlineField(name: string, value: string): EmbedField {
  const rendered = value.length > 0 ? value : EM_DASH
  return { name, value: truncate(rendered, FIELD_VALUE_MAX), inline: true }
}

function optionalInlineField(name: string, value: string | undefined): EmbedField | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }
  return inlineField(name, value)
}

function pushDefined<T>(target: T[], value: T | undefined): void {
  if (value !== undefined) {
    target.push(value)
  }
}

function appendRunContextFields(fields: EmbedField[], payload: Record<string, unknown>): void {
  pushDefined(fields, optionalInlineField('Run', asString(payload['runId'])))
  pushDefined(fields, optionalInlineField('Lane', asString(payload['laneRef'])))
  pushDefined(fields, optionalInlineField('Input', asString(payload['inputAttemptId'])))
  pushDefined(fields, optionalInlineField('Next', asString(payload['nextFireAt'])))
  pushDefined(fields, optionalInlineField('Last', asString(payload['lastFireAt'])))
}

/**
 * Build the Discord webhook payload (embed card + agent identity) for a job
 * lifecycle event. Returns undefined for unrelated event kinds so the caller can
 * skip them. We iterate on the exact visual post-impl; the field set is the
 * spec-locked Agent · Project · Task · Trigger · Run plus completion status.
 */
export function buildJobRunCard(event: JobLifecycleSystemEvent): WebhookPayload | undefined {
  if (event.kind !== JOB_DISPATCHED_EVENT && event.kind !== JOB_COMPLETED_EVENT) {
    return undefined
  }

  const payload = event.payload
  const agentId = asString(payload['agentId']) ?? 'unknown'
  const projectId = asString(payload['projectId']) ?? event.projectId
  const jobSlug = asString(payload['jobSlug']) ?? asString(payload['jobId']) ?? 'job'
  const jobRunId = asString(payload['jobRunId']) ?? EM_DASH
  const runId = asString(payload['runId']) ?? EM_DASH
  const triggeredBy = asString(payload['triggeredBy']) ?? EM_DASH
  const triggerLabel = describeTrigger(payload['trigger'])
  const taskId = resolveTaskId(payload)

  const completed = event.kind === JOB_COMPLETED_EVENT
  const status = asString(payload['status'])
  const failed = completed && status === 'failed'

  // Completed card carries the run status in the title (no separate Status field);
  // started card keeps the ▶ marker.
  const title = completed
    ? `${failed ? '✗' : '✓'} Job ${status ?? 'completed'} · ${jobSlug}`
    : `▶ Job started · ${jobSlug}`
  const color = completed ? (failed ? COLOR_FAILED : COLOR_SUCCEEDED) : COLOR_STARTED
  // Subtitle: the job's own description (one line); fall back to the
  // dispatch/completion status phrase when the job has no description.
  const jobDescription = asString(payload['description'])
  const statusPhrase = completed ? `Run ${status ?? 'finished'}` : `Dispatched (${triggeredBy})`
  const subtitle = jobDescription !== undefined ? oneLine(jobDescription) : statusPhrase

  const fields: EmbedField[] = [
    inlineField('Agent', agentId),
    inlineField('Project', projectId),
    inlineField('Task', taskId),
  ]
  if (isTaskboardTaskId(taskId)) {
    fields.push(inlineField('Terminal', `[Focus](${taskboardTerminalFocusUrl(taskId)})`))
  }
  // The completed card renders the agent's final response as markdown in the embed
  // description (under a de-emphasized subtitle); the started card keeps the
  // subtitle plus Trigger/Run fields.
  let description = subtitle
  if (completed) {
    appendRunContextFields(fields, payload)
    const finalResponse = asString(payload['finalResponse'])
    if (finalResponse !== undefined) {
      description = truncate(`-# ${subtitle}\n\n${finalResponse}`, EMBED_DESCRIPTION_MAX)
    }
    const errorMessage = asString(payload['errorMessage'])
    if (failed && errorMessage !== undefined) {
      fields.push({ name: 'Error', value: errorMessage.slice(0, 1024), inline: false })
    }
  } else {
    fields.push(inlineField('Trigger', triggerLabel), inlineField('Run', runId))
    pushDefined(fields, optionalInlineField('Lane', asString(payload['laneRef'])))
    pushDefined(fields, optionalInlineField('Input', asString(payload['inputAttemptId'])))
    pushDefined(fields, optionalInlineField('Next', asString(payload['nextFireAt'])))
    pushDefined(fields, optionalInlineField('Last', asString(payload['lastFireAt'])))
  }

  const embed = {
    title: title.slice(0, 256),
    description,
    color,
    thumbnail: { url: avatarFor(agentId) },
    fields,
    footer: { text: `jobRun ${jobRunId}` },
    timestamp: event.occurredAt,
  }

  return {
    username: `${agentId} · jobs`,
    avatar_url: avatarFor(agentId),
    embeds: [embed],
  }
}

const FAILURE_CARDS_PER_WINDOW = 3
const FAILURE_CARD_WINDOW_MS = 10 * 60_000
const SUMMARY_CODES_MAX = 10

type FailureWindow = {
  startedAt: number
  posted: number
  suppressed: number
  agentId: string
  projectId: string
  errorCodes: Map<string, number>
  firstJobRunId?: string | undefined
  lastJobRunId?: string | undefined
}

/**
 * Bounds #job-runs failure cards (T-10005): per job slug, at most 3 individual
 * failed `job.completed` cards per 10-minute window. Further failures in the
 * window are counted, and one summary card reports them once the window ends,
 * so a mass failure (e.g. a dead sink settling a backlog) cannot flood the
 * channel. Started and succeeded cards are never limited. In-memory: a restart
 * starts fresh windows.
 */
export class JobRunFailureCardLimiter {
  private readonly windows = new Map<string, FailureWindow>()
  private readonly now: () => number
  private readonly perWindow: number
  private readonly windowMs: number

  constructor(
    options: {
      now?: (() => number) | undefined
      perWindow?: number | undefined
      windowMs?: number | undefined
    } = {}
  ) {
    this.now = options.now ?? Date.now
    this.perWindow = options.perWindow ?? FAILURE_CARDS_PER_WINDOW
    this.windowMs = options.windowMs ?? FAILURE_CARD_WINDOW_MS
  }

  /** True when the event's card should be posted; false when it is counted
   * toward its job's summary instead. */
  admit(event: JobLifecycleSystemEvent): boolean {
    if (event.kind !== JOB_COMPLETED_EVENT || event.payload['status'] !== 'failed') {
      return true
    }
    const payload = event.payload
    const slug = asString(payload['jobSlug']) ?? asString(payload['jobId']) ?? 'job'
    const now = this.now()
    let window = this.windows.get(slug)
    if (
      window !== undefined &&
      now - window.startedAt >= this.windowMs &&
      window.suppressed === 0
    ) {
      this.windows.delete(slug)
      window = undefined
    }
    if (window === undefined) {
      window = {
        startedAt: now,
        posted: 0,
        suppressed: 0,
        agentId: asString(payload['agentId']) ?? 'unknown',
        projectId: asString(payload['projectId']) ?? event.projectId,
        errorCodes: new Map(),
      }
      this.windows.set(slug, window)
    }
    if (window.posted < this.perWindow) {
      window.posted += 1
      return true
    }
    window.suppressed += 1
    const errorCode = asString(payload['errorCode']) ?? 'unknown'
    window.errorCodes.set(errorCode, (window.errorCodes.get(errorCode) ?? 0) + 1)
    const jobRunId = asString(payload['jobRunId'])
    window.firstJobRunId ??= jobRunId
    window.lastJobRunId = jobRunId ?? window.lastJobRunId
    return false
  }

  /** Summary cards for windows that have ended with suppressed failures. Each
   * window is reported once and then cleared. */
  takeSummaries(): WebhookPayload[] {
    const now = this.now()
    const cards: WebhookPayload[] = []
    for (const [slug, window] of this.windows) {
      if (now - window.startedAt < this.windowMs) {
        continue
      }
      this.windows.delete(slug)
      if (window.suppressed > 0) {
        cards.push(buildFailureSummaryCard(slug, window, this.perWindow, this.windowMs))
      }
    }
    return cards
  }
}

function buildFailureSummaryCard(
  slug: string,
  window: FailureWindow,
  perWindow: number,
  windowMs: number
): WebhookPayload {
  const codes = [...window.errorCodes.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, SUMMARY_CODES_MAX)
    .map(([code, count]) => `${code} × ${count}`)
    .join('\n')
  const runs =
    window.firstJobRunId === window.lastJobRunId
      ? (window.firstJobRunId ?? EM_DASH)
      : `${window.firstJobRunId ?? EM_DASH} … ${window.lastJobRunId ?? EM_DASH}`
  const noun = window.suppressed === 1 ? 'run' : 'runs'
  return {
    username: `${window.agentId} · jobs`,
    avatar_url: avatarFor(window.agentId),
    embeds: [
      {
        title: `✗ ${window.suppressed} more failed ${noun} · ${slug}`.slice(0, 256),
        description: `This job failed more than ${perWindow} times in ${Math.round(windowMs / 60_000)} minutes. The extra failures are summarised here rather than posted one by one.`,
        color: COLOR_FAILED,
        thumbnail: { url: avatarFor(window.agentId) },
        fields: [
          inlineField('Agent', window.agentId),
          inlineField('Project', window.projectId),
          { name: 'Errors', value: truncate(codes || EM_DASH, FIELD_VALUE_MAX), inline: false },
          { name: 'Runs', value: truncate(runs, FIELD_VALUE_MAX), inline: false },
        ],
        timestamp: new Date(window.startedAt).toISOString(),
      },
    ],
  }
}
