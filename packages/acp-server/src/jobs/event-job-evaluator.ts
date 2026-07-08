import {
  type AcpWebhookEvent,
  evaluateEventMatch,
  isAgentOriginEvent,
  parseAcpWebhookEvent,
  parseDurationToMs,
  resolveEventAction,
} from 'acp-core'

import type {
  EvaluateEventJob,
  EventJobEvaluation,
  InboxEventRecord,
  JobRecord,
} from 'acp-jobs-store'

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

  const parsed = parseAcpWebhookEvent(inboxEvent.payload)
  if (!parsed.ok) {
    return { decision: 'skip', reason: 'match_false' }
  }
  const event = parsed.event

  // Source is the first match boundary. Other predicates must never run for a
  // different producer with a coincidentally similar payload shape.
  if (trigger.source !== event.source) {
    return { decision: 'skip', reason: 'match_false' }
  }

  // 1. Match predicate.
  if (!evaluateEventMatch(trigger.match, event)) {
    return { decision: 'skip', reason: 'match_false' }
  }

  // 2. Origin policy — cascade/loop control. Absent policy keeps the total
  // agent-origin block; compiled agent-authored hooks carry an explicit
  // deny-self (daedalus #13229 ruled only the compiled default).
  const agentPolicy = trigger.originPolicy?.agent ?? 'deny'
  if (agentPolicy === 'deny' && isAgentOriginEvent(event)) {
    return { decision: 'skip', reason: 'agent_origin_blocked' }
  }
  if (agentPolicy === 'deny-self' && isSelfAgentOrigin(event, job.agentId)) {
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
      canonicalEventId: event.canonical_event_id,
      eventSeq: event.event_seq,
      event: event.event,
      ...(event.subject !== undefined ? { subject: event.subject } : {}),
      ...(event.origin?.actor !== undefined ? { originActor: event.origin.actor } : {}),
    },
    targetTaskId: resolved.resolved.targetKey,
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  }
}

function isSelfAgentOrigin(event: AcpWebhookEvent, jobAgentId: string): boolean {
  const actor = event.origin?.actor
  const agentId = parseExactAgentActor(actor)
  if (agentId !== undefined) {
    return agentId === jobAgentId
  }
  // Fail-closed: any agent-origin event without an exact agent:<id> actor
  // (kind='agent' with no actor, or a malformed/scoped actor string) must not
  // pass as safe cross-agent traffic.
  return isAgentOriginEvent(event)
}

function parseExactAgentActor(actor: unknown): string | undefined {
  if (typeof actor !== 'string') {
    return undefined
  }
  const match = /^agent:([^:]+)$/.exec(actor)
  return match?.[1]
}
