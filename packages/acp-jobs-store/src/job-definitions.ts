import { normalizeExecutionNodes } from './execution-admission.js'
import {
  type JobRow,
  actorToStamp,
  getJobRow,
  newId,
  requireJobRow,
  resolveActor,
  toJobRecord,
} from './row-codecs.js'
import { resolveTrigger, scheduleColumnsForTrigger } from './schedule-policy.js'
import type { SqliteDatabase } from './sqlite.js'
import type { CreateJobInput, JobRecord, ListJobsInput, UpdateJobInput } from './store-contracts.js'

export const JOB_SLUG_REGEX = /^[a-z0-9][a-z0-9._-]{0,79}$/

export function isValidJobSlug(value: string): boolean {
  return JOB_SLUG_REGEX.test(value)
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

export function createJobDefinitions(sqlite: SqliteDatabase) {
  const createJob = (input: CreateJobInput): { job: JobRecord } => {
    const now = new Date(input.createdAt ?? Date.now()).toISOString()
    const actor = resolveActor(input.actor)
    const disabled = input.disabled ?? false
    const trigger = resolveTrigger(input)
    const columns = scheduleColumnsForTrigger({
      trigger,
      schedule: input.schedule,
      disabled,
      anchor: now,
    })
    const jobId = input.jobId ?? newId('job')
    const slug = input.slug ?? jobId
    if (!isValidJobSlug(slug)) {
      throw new Error(`invalid job slug: ${slug}`)
    }
    if (input.output !== undefined && input.flow !== undefined) {
      throw new Error('job output is only supported for non-flow jobs')
    }
    const description = normalizeOptionalString(input.description)
    const executionNodes = normalizeExecutionNodes(input.executionNodes)

    sqlite
      .prepare(
        `
          INSERT INTO jobs (
            job_id,
            slug,
            description,
            project_id,
            agent_id,
            scope_ref,
            lane_ref,
            trigger_kind,
            trigger_json,
            schedule_cron,
            schedule_window_start,
            schedule_window_end,
            schedule_json,
            input_json,
            output_json,
            flow_json,
            execution_nodes_json,
            disabled,
            last_fire_at,
            next_fire_at,
            actor_kind,
            actor_id,
            actor_display_name,
            actor_stamp,
            created_at,
            updated_at,
            archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `
      )
      .run(
        jobId,
        slug,
        description ?? null,
        input.projectId,
        input.agentId,
        input.scopeRef,
        input.laneRef ?? 'main',
        trigger.kind,
        JSON.stringify(trigger),
        columns.scheduleCron,
        columns.windowStart,
        columns.windowEnd,
        columns.scheduleJson,
        JSON.stringify(input.input),
        input.output !== undefined ? JSON.stringify(input.output) : null,
        input.flow !== undefined ? JSON.stringify(input.flow) : null,
        executionNodes !== undefined ? JSON.stringify(executionNodes) : null,
        disabled ? 1 : 0,
        null,
        columns.nextFireAt,
        actor.kind,
        actor.id,
        actor.displayName ?? null,
        input.actorStamp ?? actorToStamp(actor),
        now,
        now
      )

    return { job: toJobRecord(requireJobRow(sqlite, jobId)) }
  }

  const listJobs = (input?: ListJobsInput | undefined): { jobs: JobRecord[] } => {
    const rows = sqlite
      .prepare(`
      SELECT * FROM jobs
      WHERE archived_at IS NULL ${input?.projectId !== undefined ? 'AND project_id = ?' : ''}
      ORDER BY created_at DESC, job_id DESC
    `)
      .all(...(input?.projectId !== undefined ? [input.projectId] : [])) as JobRow[]
    return { jobs: rows.map(toJobRecord) }
  }

  const getJob = (jobId: string): { job: JobRecord | undefined } => {
    const row = getJobRow(sqlite, jobId)
    return { job: row === undefined ? undefined : toJobRecord(row) }
  }

  const updateJob = (jobId: string, patch: UpdateJobInput): { job: JobRecord } => {
    const existing = requireJobRow(sqlite, jobId)
    const existingJob = toJobRecord(existing)
    const disabled = patch.disabled ?? existingJob.disabled
    const flow = patch.flow ?? existingJob.flow
    const output =
      'output' in patch ? (patch.output === null ? undefined : patch.output) : existingJob.output
    const executionNodes =
      'executionNodes' in patch
        ? patch.executionNodes === null
          ? undefined
          : normalizeExecutionNodes(patch.executionNodes)
        : existingJob.executionNodes
    if (output !== undefined && flow !== undefined) {
      throw new Error('job output is only supported for non-flow jobs')
    }
    const slug = patch.slug ?? existingJob.slug
    if (patch.slug !== undefined && !isValidJobSlug(patch.slug)) {
      throw new Error(`invalid job slug: ${patch.slug}`)
    }
    const description =
      patch.description === null
        ? null
        : patch.description !== undefined
          ? (normalizeOptionalString(patch.description) ?? null)
          : (existing.description ?? null)
    const now = new Date().toISOString()

    const triggerChanged = patch.trigger !== undefined || patch.schedule !== undefined
    const trigger =
      patch.trigger !== undefined
        ? resolveTrigger({ trigger: patch.trigger })
        : patch.schedule !== undefined
          ? resolveTrigger({ schedule: patch.schedule })
          : existingJob.trigger
    const columns =
      triggerChanged || patch.disabled !== undefined
        ? scheduleColumnsForTrigger({
            trigger,
            schedule: patch.schedule ?? existingJob.schedule,
            disabled,
            anchor: now,
          })
        : {
            scheduleCron: existing.schedule_cron,
            windowStart: existing.schedule_window_start,
            windowEnd: existing.schedule_window_end,
            scheduleJson: existing.schedule_json,
            nextFireAt: existing.next_fire_at,
          }

    sqlite
      .prepare(
        `
          UPDATE jobs
          SET slug = ?,
              description = ?,
              trigger_kind = ?,
              trigger_json = ?,
              schedule_cron = ?,
              schedule_window_start = ?,
              schedule_window_end = ?,
              schedule_json = ?,
              input_json = ?,
              output_json = ?,
              flow_json = ?,
              execution_nodes_json = ?,
              disabled = ?,
              next_fire_at = ?,
              actor_kind = ?,
              actor_id = ?,
              actor_display_name = ?,
              actor_stamp = ?,
              updated_at = ?
          WHERE job_id = ? AND archived_at IS NULL
        `
      )
      .run(
        slug,
        description,
        trigger.kind,
        JSON.stringify(trigger),
        columns.scheduleCron,
        columns.windowStart,
        columns.windowEnd,
        columns.scheduleJson,
        JSON.stringify(patch.input ?? existingJob.input),
        output !== undefined ? JSON.stringify(output) : null,
        flow !== undefined ? JSON.stringify(flow) : null,
        executionNodes !== undefined ? JSON.stringify(executionNodes) : null,
        disabled ? 1 : 0,
        columns.nextFireAt,
        patch.actor?.kind ?? existing.actor_kind,
        patch.actor?.id ?? existing.actor_id,
        patch.actor?.displayName ?? existing.actor_display_name,
        patch.actorStamp ??
          (patch.actor !== undefined ? actorToStamp(patch.actor) : existing.actor_stamp),
        now,
        jobId
      )

    return { job: toJobRecord(requireJobRow(sqlite, jobId)) }
  }

  const archiveJob = (jobId: string): void => {
    const now = new Date().toISOString()
    sqlite
      .prepare(
        'UPDATE jobs SET archived_at = ?, updated_at = ? WHERE job_id = ? AND archived_at IS NULL'
      )
      .run(now, now, jobId)
  }

  const listActiveEventJobs = (): { jobs: JobRecord[] } => ({
    jobs: (
      sqlite
        .prepare(
          `
            SELECT *
            FROM jobs
            WHERE archived_at IS NULL
              AND disabled = 0
              AND trigger_kind = 'event'
            ORDER BY created_at ASC, job_id ASC
          `
        )
        .all() as JobRow[]
    ).map((row) => toJobRecord(row)),
  })
  return { createJob, listJobs, getJob, updateJob, archiveJob, listActiveEventJobs }
}
