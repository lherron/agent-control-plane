import type { InputQueueItem } from 'acp-core'
import { canonicalAcpEventId } from 'acp-core'
import {
  type JobRecord,
  type JobsStore,
  isHealthDiagnosticRun,
  validateJobFlow,
} from 'acp-jobs-store'

import type { StoredRun } from '../domain/run-store.js'

export const ACP_HEALTH_SOURCE = 'acp-health'
export const DISPATCH_TIMEOUT_EVENT = 'run.dispatch_timeout'
export const DISPATCH_TIMEOUT_HEALTH_JOB_SLUG = 'acp-health-dispatch-timeout-fettle'
export const FETTLE_PULPIT_BINDING_ID = 'agent-fettle.discord-primary'

const HEALTH_JOB_PROJECT_ID = 'agent-control-plane'
const HEALTH_JOB_AGENT_ID = 'acp-health'
const FETTLE_AGENT_ID = 'fettle'
const FETTLE_PROJECT_ID = 'agent-control-plane'
const HEALTH_JOB_SCOPE_REF = `agent:${FETTLE_AGENT_ID}:project:${FETTLE_PROJECT_ID}:task:primary`
const HEALTH_JOB_LANE_REF = 'main'

export function ensureDispatchTimeoutHealthJob(store: JobsStore): JobRecord {
  const desired = dispatchTimeoutHealthJobInput()
  const existing = store
    .listJobs({ projectId: HEALTH_JOB_PROJECT_ID })
    .jobs.find((job) => job.slug === DISPATCH_TIMEOUT_HEALTH_JOB_SLUG)

  if (existing === undefined) {
    return store.createJob(desired).job
  }

  return store.updateJob(existing.jobId, {
    description: desired.description,
    trigger: desired.trigger,
    input: desired.input,
    flow: desired.flow,
    disabled: false,
  }).job
}

export function emitDispatchTimeoutHealthEvent(input: {
  jobsStore?: JobsStore | undefined
  run: StoredRun
  queueItem?: InputQueueItem | undefined
  originVia: 'input-queue-dispatcher' | 'interface-run-dispatcher'
  occurredAt?: string | undefined
}): { inserted: boolean; eventId?: string | undefined; skipped: boolean } {
  if (input.jobsStore === undefined) {
    return { inserted: false, skipped: true }
  }
  if (input.run.errorCode !== 'dispatch_timeout' || isHealthDiagnosticRun(input.run)) {
    return { inserted: false, skipped: true }
  }

  const occurredAt = input.occurredAt ?? new Date().toISOString()
  const eventId = `${DISPATCH_TIMEOUT_EVENT}:${input.run.runId}`
  const canonicalEventId = canonicalAcpEventId(ACP_HEALTH_SOURCE, eventId)
  const payload = {
    schema_version: 1,
    source: ACP_HEALTH_SOURCE,
    event_id: eventId,
    canonical_event_id: canonicalEventId,
    event_seq: eventSeqForRun(input.run),
    event: DISPATCH_TIMEOUT_EVENT,
    occurred_at: occurredAt,
    origin: {
      kind: 'system',
      actor: 'system:acp-health',
      via: input.originVia,
    },
    subject: {
      type: 'acp-session-lane',
      id: `${input.run.scopeRef}#${input.run.laneRef}`,
    },
    payload: {
      runId: input.run.runId,
      scopeRef: input.run.scopeRef,
      laneRef: input.run.laneRef,
      status: input.run.status,
      errorCode: input.run.errorCode,
      ...(input.run.errorMessage !== undefined ? { errorMessage: input.run.errorMessage } : {}),
      createdAt: input.run.createdAt,
      updatedAt: input.run.updatedAt,
      ...(input.run.hrcRunId !== undefined ? { hrcRunId: input.run.hrcRunId } : {}),
      ...(input.run.hostSessionId !== undefined ? { hostSessionId: input.run.hostSessionId } : {}),
      ...(input.run.runtimeId !== undefined ? { runtimeId: input.run.runtimeId } : {}),
      ...(input.run.generation !== undefined ? { generation: input.run.generation } : {}),
      ...(input.queueItem !== undefined
        ? {
            queue: {
              queueItemId: input.queueItem.queueItemId,
              inputAttemptId: input.queueItem.inputAttemptId,
              status: input.queueItem.status,
              seq: input.queueItem.seq,
            },
          }
        : {}),
    },
  }

  const result = input.jobsStore.insertInboxEvent({
    eventId,
    eventSeq: payload.event_seq,
    source: ACP_HEALTH_SOURCE,
    event: DISPATCH_TIMEOUT_EVENT,
    occurredAt,
    payload,
    receivedAt: occurredAt,
  })

  return { inserted: result.inserted, eventId: canonicalEventId, skipped: false }
}

function eventSeqForRun(run: StoredRun): number {
  const parsed = Date.parse(run.createdAt)
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed
  }
  let hash = 0
  for (const ch of run.runId) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }
  return hash
}

function dispatchTimeoutHealthJobInput() {
  const flow = {
    sequence: [
      {
        id: 'create_task',
        kind: 'wrkq-task' as const,
        title: 'ACP health: dispatch timeout',
        container: `${HEALTH_JOB_PROJECT_ID}/inbox`,
      },
      {
        id: 'notify_fettle',
        kind: 'pulpit-message' as const,
        binding: FETTLE_PULPIT_BINDING_ID,
        content:
          'Fettle diagnostic dispatching for ACP dispatch timeout. Task: {{create_task.taskId}}',
      },
      {
        id: 'dispatch_fettle',
        kind: 'agent-dispatch' as const,
        agentId: FETTLE_AGENT_ID,
        projectId: FETTLE_PROJECT_ID,
        scopeRef: { $step: 'create_task', field: 'taskId' },
        laneRef: HEALTH_JOB_LANE_REF,
        input: {
          content:
            'Diagnose the ACP dispatch_timeout incident and record RCA/remediation notes on this wrkq task.\n\nTask: {{create_task.taskId}}\n\nIncident:\n{{input.content}}',
        },
      },
    ],
  }
  const validation = validateJobFlow(flow, { allowInputFile: false })
  if (!validation.valid) {
    throw new Error(
      `built-in dispatch-timeout health flow is invalid: ${validation.errors.map((e) => e.message).join('; ')}`
    )
  }

  return {
    slug: DISPATCH_TIMEOUT_HEALTH_JOB_SLUG,
    description:
      'Built-in ACP health flow for dispatch_timeout incidents: create wrkq task, notify #fettle, dispatch fettle.',
    projectId: HEALTH_JOB_PROJECT_ID,
    agentId: HEALTH_JOB_AGENT_ID,
    scopeRef: HEALTH_JOB_SCOPE_REF,
    laneRef: HEALTH_JOB_LANE_REF,
    trigger: {
      kind: 'event' as const,
      source: ACP_HEALTH_SOURCE,
      match: { event: DISPATCH_TIMEOUT_EVENT },
      cooldown: '300s',
    },
    input: {
      content:
        'ACP dispatch_timeout incident\n\nRun: {{payload.runId}}\nSession: {{payload.scopeRef}} / {{payload.laneRef}}\nError: {{payload.errorMessage}}\nOrigin: {{origin_actor}} via {{origin_kind}}\nEvent: {{canonical_event_id}}',
    },
    flow,
    disabled: false,
    createdAt: '2026-06-19T00:00:00.000Z',
  }
}
