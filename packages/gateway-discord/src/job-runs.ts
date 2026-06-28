import { parseScopeRef } from 'agent-scope'

import { avatarFor } from './identity.js'
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
  return { name, value: value.length > 0 ? value : EM_DASH, inline: true }
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
  // The completed card renders the agent's final response as markdown in the embed
  // description (under a de-emphasized subtitle); the started card keeps the
  // subtitle plus Trigger/Run fields.
  let description = subtitle
  if (completed) {
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
