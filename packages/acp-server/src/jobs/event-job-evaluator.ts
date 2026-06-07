import {
  evaluateEventMatch,
  isAgentOriginEvent,
  parseDurationToMs,
  parseWrkqWebhookEvent,
  resolveEventAction,
} from 'acp-core'

import type { EvaluateEventJob, EventJobEvaluation, InboxEventRecord, JobRecord } from 'acp-jobs-store'

/**
 * Build the pure (event, job) decision function the scheduler injects into its
 * event-claim branch. Order: match → origin policy → fail-closed template
 * resolution. Cooldown is a store-backed backstop applied by the scheduler.
 */
export function createEventJobEvaluator(): EvaluateEventJob {
  return ({ job, event }) => evaluateEventJob(job, event)
}

function evaluateEventJob(job: JobRecord, inboxEvent: InboxEventRecord): EventJobEvaluation {
  const trigger = job.trigger
  if (trigger.kind !== 'event') {
    return { decision: 'skip', reason: 'match_false' }
  }

  const parsed = parseWrkqWebhookEvent(inboxEvent.payload)
  if (!parsed.ok) {
    return { decision: 'skip', reason: 'match_false' }
  }
  const event = parsed.event

  // 1. Match predicate.
  if (!evaluateEventMatch(trigger.match, event)) {
    return { decision: 'skip', reason: 'match_false' }
  }

  // 2. Origin policy — cascade/loop control. Default denies agent-origin events.
  const agentPolicy = trigger.originPolicy?.agent ?? 'deny'
  if (agentPolicy === 'deny' && isAgentOriginEvent(event)) {
    return { decision: 'skip', reason: 'agent_origin_blocked' }
  }

  // 3. Resolve the action fail-closed (templates + SessionRef validation).
  const resolved = resolveEventAction({
    scopeRefTemplate: job.scopeRef,
    laneRefTemplate: job.laneRef,
    inputTemplate: job.input,
    event,
  })
  if (!resolved.ok) {
    return { decision: 'skip', reason: 'template_error' }
  }

  const cooldownMs =
    trigger.cooldown !== undefined ? parseDurationToMs(trigger.cooldown) : undefined

  return {
    decision: 'mint',
    resolved: {
      scopeRef: resolved.resolved.scopeRef,
      laneRef: resolved.resolved.laneRef,
      input: resolved.resolved.input,
    },
    source: {
      kind: 'webhook',
      source: trigger.source,
      eventId: event.event_id,
      eventSeq: event.event_seq,
      event: event.event,
      ...(event.ticket_id !== undefined ? { ticketId: event.ticket_id } : {}),
      ...(event.origin?.actor !== undefined ? { originActor: event.origin.actor } : {}),
    },
    ...(resolved.resolved.targetTaskId !== undefined
      ? { targetTaskId: resolved.resolved.targetTaskId }
      : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  }
}
