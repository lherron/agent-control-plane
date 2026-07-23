import { createHash } from 'node:crypto'

import { parseAcpWebhookEvent } from 'acp-core'
import type { DeliveryRequest, InterfaceStore } from 'acp-interface-store'
import {
  type JobExecutionIdentity,
  type JobOutputSink,
  type JobRecord,
  type JobRunRecord,
  type JobsStore,
  fingerprintJobOutputSink,
} from 'acp-jobs-store'

import type { RunStore, StoredRun } from '../domain/run-store.js'
import { isRecord } from '../parsers/body.js'
import { isLoopbackWebhookUrl } from './job-output-config.js'

export type JobOutputReconcilerInput = {
  jobsStore: JobsStore
  runStore: RunStore
  interfaceStore: InterfaceStore
  fetch?: typeof fetch | undefined
  now?: () => Date
  limit?: number | undefined
  timeoutMs?: number | undefined
  maxPayloadBytes?: number | undefined
  /**
   * Observer hook: invoked with the committed job-run record after each terminal
   * transition (non-flow completion path). Used to project job.completed lifecycle
   * telemetry. Must never throw back into reconciliation or mutate job state.
   */
  onJobRunSettled?: ((run: JobRunRecord, job: JobRecord) => void) | undefined
}

export type JobOutputReconciler = {
  runOnce(executionIdentity?: JobExecutionIdentity | undefined): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_PAYLOAD_BYTES = 1_000_000

export function createJobOutputReconciler(input: JobOutputReconcilerInput): JobOutputReconciler {
  const fetchImpl = input.fetch ?? fetch
  const now = input.now ?? (() => new Date())
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxPayloadBytes = input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES

  async function runOnce(executionIdentity?: JobExecutionIdentity | undefined): Promise<void> {
    const entries = input.jobsStore.listDispatchedNonFlowJobRuns({
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(executionIdentity !== undefined ? { executionNodeId: executionIdentity.nodeId } : {}),
    })

    for (const entry of entries) {
      try {
        await reconcile(entry.job, entry.jobRun)
      } catch (error) {
        console.error(
          `[job-output-reconciler] failed to reconcile ${entry.jobRun.jobRunId}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  async function reconcile(job: JobRecord, jobRun: JobRunRecord): Promise<void> {
    const run = jobRun.runId === undefined ? undefined : input.runStore.getRun(jobRun.runId)
    if (run === undefined) {
      return
    }

    // Commit a terminal job-run transition and project it to the lifecycle
    // observer. The observer is best-effort and isolated: it never alters the
    // committed job-run state (jobs store remains source of truth).
    const settle = (patch: Parameters<JobsStore['updateJobRun']>[1]): void => {
      const { jobRun: settled } = input.jobsStore.updateJobRun(jobRun.jobRunId, patch)
      try {
        input.onJobRunSettled?.(settled, job)
      } catch (error) {
        console.error(
          `[job-output-reconciler] lifecycle emit failed for ${settled.jobRunId}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    const nowIso = now().toISOString()
    if (run.status === 'failed' || run.status === 'cancelled') {
      settle({
        status: 'failed',
        errorCode: `run_${run.status}`,
        errorMessage: run.errorMessage ?? `ACP run ${run.runId} ended ${run.status}`,
        completedAt: nowIso,
      })
      return
    }

    if (run.status !== 'completed') {
      return
    }

    const sinks = jobRun.output?.sinks ?? []
    if (sinks.length === 0) {
      settle({
        status: 'succeeded',
        completedAt: nowIso,
      })
      return
    }

    const delivery = selectFinalDelivery(input.interfaceStore.deliveries.listByRun(run.runId))
    if (delivery === undefined) {
      settle({
        status: 'failed',
        errorCode: 'output_delivery_missing',
        errorMessage: `ACP run ${run.runId} completed without a final text/markdown interface delivery`,
        completedAt: nowIso,
      })
      return
    }

    const trigger = loadTrigger(jobRun)
    const results = await Promise.all(
      sinks.map((sink, sinkIndex) =>
        reconcileSink({
          jobRun,
          job,
          run,
          delivery,
          sink,
          sinkIndex,
          trigger,
          nowIso,
        })
      )
    )

    if (results.every((result) => result === 'succeeded')) {
      settle({
        status: 'succeeded',
        completedAt: nowIso,
      })
    }
  }

  async function reconcileSink(inputForSink: {
    job: JobRecord
    jobRun: JobRunRecord
    run: StoredRun
    delivery: DeliveryRequest
    sink: JobOutputSink
    sinkIndex: number
    trigger: TriggerPayload
    nowIso: string
  }): Promise<'succeeded' | 'pending'> {
    const { job, jobRun, sink, sinkIndex, delivery, run, trigger, nowIso } = inputForSink
    const sinkFingerprint = fingerprintJobOutputSink(sink)
    const existing = input.jobsStore.getJobOutputSinkAttempt({
      jobRunId: jobRun.jobRunId,
      sinkIndex,
      sinkFingerprint,
    }).attempt

    if (existing?.status === 'succeeded') {
      return 'succeeded'
    }
    if (existing?.nextAttemptAt !== undefined && existing.nextAttemptAt > nowIso) {
      return 'pending'
    }

    if (sink.kind !== 'webhook' || !isLoopbackWebhookUrl(sink.url)) {
      input.jobsStore.recordJobOutputSinkAttempt({
        jobRunId: jobRun.jobRunId,
        sinkIndex,
        sinkFingerprint,
        status: 'failed',
        attemptedAt: nowIso,
        lastError: 'invalid webhook sink',
      })
      return 'pending'
    }

    const payload = buildPayload({
      jobRun,
      job,
      run,
      delivery,
      sink,
      trigger,
    })
    const payloadJson = JSON.stringify(payload)
    if (Buffer.byteLength(payloadJson, 'utf8') > maxPayloadBytes) {
      input.jobsStore.recordJobOutputSinkAttempt({
        jobRunId: jobRun.jobRunId,
        sinkIndex,
        sinkFingerprint,
        status: 'failed',
        attemptedAt: nowIso,
        deliveryRequestId: delivery.deliveryRequestId,
        payloadHash: hashText(payloadJson),
        bodyHash: hashText(delivery.bodyText),
        lastError: 'payload too large',
      })
      return 'pending'
    }

    const idempotencyKey = `acp-job-output:${jobRun.jobRunId}:${sinkIndex}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(sink.url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: payloadJson,
      })

      if (response.status >= 200 && response.status < 300) {
        input.jobsStore.recordJobOutputSinkAttempt({
          jobRunId: jobRun.jobRunId,
          sinkIndex,
          sinkFingerprint,
          status: 'succeeded',
          attemptedAt: nowIso,
          deliveredAt: nowIso,
          deliveryRequestId: delivery.deliveryRequestId,
          payloadHash: hashText(payloadJson),
          bodyHash: hashText(delivery.bodyText),
          responseStatus: response.status,
        })
        return 'succeeded'
      }

      input.jobsStore.recordJobOutputSinkAttempt({
        jobRunId: jobRun.jobRunId,
        sinkIndex,
        sinkFingerprint,
        status: 'failed',
        attemptedAt: nowIso,
        nextAttemptAt: nextRetryAt(nowIso, existing?.attempts ?? 0),
        deliveryRequestId: delivery.deliveryRequestId,
        payloadHash: hashText(payloadJson),
        bodyHash: hashText(delivery.bodyText),
        responseStatus: response.status,
        lastError: `webhook returned HTTP ${response.status}`,
      })
      return 'pending'
    } catch (error) {
      input.jobsStore.recordJobOutputSinkAttempt({
        jobRunId: jobRun.jobRunId,
        sinkIndex,
        sinkFingerprint,
        status: 'failed',
        attemptedAt: nowIso,
        nextAttemptAt: nextRetryAt(nowIso, existing?.attempts ?? 0),
        deliveryRequestId: delivery.deliveryRequestId,
        payloadHash: hashText(payloadJson),
        bodyHash: hashText(delivery.bodyText),
        lastError: error instanceof Error ? error.message : String(error),
      })
      return 'pending'
    } finally {
      clearTimeout(timeout)
    }
  }

  function loadTrigger(jobRun: JobRunRecord): TriggerPayload {
    const canonicalEventId = stringField(jobRun.source, 'canonicalEventId')
    const eventId = stringField(jobRun.source, 'eventId')
    const source = stringField(jobRun.source, 'source')
    const candidates = [
      canonicalEventId,
      eventId !== undefined && source !== undefined ? `${source}:${eventId}` : undefined,
      eventId,
    ].filter((candidate): candidate is string => candidate !== undefined)

    for (const candidate of candidates) {
      const event = input.jobsStore.getInboxEvent(candidate).event
      if (event !== undefined) {
        const parsed = parseAcpWebhookEvent(event.payload)
        return {
          event: parsed.ok ? parsed.event : event.payload,
          payload:
            parsed.ok && isRecord(parsed.event.payload)
              ? parsed.event.payload
              : isRecord(event.payload['payload'])
                ? event.payload['payload']
                : {},
        }
      }
    }

    return { event: {}, payload: {} }
  }

  return { runOnce }
}

type TriggerPayload = {
  event: Readonly<Record<string, unknown>>
  payload: Readonly<Record<string, unknown>>
}

function selectFinalDelivery(deliveries: DeliveryRequest[]): DeliveryRequest | undefined {
  return deliveries
    .filter(
      (delivery) =>
        !delivery.deliveryRequestId.includes('_oob_') &&
        delivery.bodyKind === 'text/markdown' &&
        delivery.bodyText.trim().length > 0
    )
    .sort(compareDeliveryDescending)[0]
}

function compareDeliveryDescending(left: DeliveryRequest, right: DeliveryRequest): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt)
  }
  return right.deliveryRequestId.localeCompare(left.deliveryRequestId)
}

function buildPayload(input: {
  jobRun: JobRunRecord
  job: JobRecord
  run: StoredRun
  delivery: DeliveryRequest
  sink: JobOutputSink
  trigger: TriggerPayload
}): Record<string, unknown> {
  const { job, jobRun, run, delivery, sink, trigger } = input
  return {
    source: 'acp-event-job',
    job_slug: job.slug,
    job_id: jobRun.jobId,
    job_run_id: jobRun.jobRunId,
    event_id: stringField(jobRun.source, 'eventId'),
    canonical_event_id: stringField(jobRun.source, 'canonicalEventId'),
    delivery_request_id: delivery.deliveryRequestId,
    trigger: trigger.event,
    payload: trigger.payload,
    output: {
      kind: 'text',
      format: sink.format ?? 'discord_markdown',
      text: delivery.bodyText,
    },
    provenance: {
      run_id: run.runId,
      input_attempt_id: jobRun.inputAttemptId,
      gateway_id: delivery.gatewayId,
      binding_id: delivery.bindingId,
      conversation_ref: delivery.conversationRef,
      thread_ref: delivery.threadRef,
    },
  }
}

function stringField(
  record: Readonly<Record<string, unknown>> | undefined,
  field: string
): string | undefined {
  const value = record?.[field]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function nextRetryAt(nowIso: string, previousAttempts: number): string {
  const delayMs = Math.min(60_000 * 2 ** previousAttempts, 15 * 60_000)
  return new Date(Date.parse(nowIso) + delayMs).toISOString()
}
