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
  EventJobSkipReason,
  InboxEventRecord,
  JobRecord,
  JobsStore,
} from 'acp-jobs-store'

export const DEFAULT_CAUSATION_DEPTH_LIMIT = 8

/**
 * Build the pure (event, job) decision function the scheduler injects into its
 * event-claim branch. Order: match → origin policy → fail-closed template
 * resolution. Cooldown is a store-backed backstop applied by the scheduler.
 */
export function createEventJobEvaluator(
  options: { causationDepthLimit?: number | undefined } = {}
): EvaluateEventJob {
  const causationDepthLimit = options.causationDepthLimit ?? DEFAULT_CAUSATION_DEPTH_LIMIT
  return ({ job, event, store }) => evaluateEventJob(job, event, store, causationDepthLimit)
}

function evaluateEventJob(
  job: JobRecord,
  inboxEvent: InboxEventRecord,
  store: JobsStore,
  causationDepthLimit: number
): EventJobEvaluation {
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

  // 3. Causation-chain loop control. Missing refs, pruned inbox rows, unknown
  // jrun ids, and malformed rows end the ancestry walk as orphaned/fail-open:
  // they are not errors and do not skip by themselves. A deliberately forged
  // valid ref can still suppress a hook via a false cycle; that is accepted
  // under the existing cooldown-era threat model.
  const causationSkip = evaluateCausationChain({
    store,
    candidateJobId: job.jobId,
    event,
    depthLimit: causationDepthLimit,
  })
  if (causationSkip !== undefined) {
    return { decision: 'skip', reason: causationSkip }
  }

  // 4. Resolve the action fail-closed (templates + SessionRef validation).
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

function evaluateCausationChain(input: {
  store: JobsStore
  candidateJobId: string
  event: AcpWebhookEvent
  depthLimit: number
}): EventJobSkipReason | undefined {
  let causationRef = readCausationRef(input.event)
  if (causationRef === undefined) {
    return undefined
  }

  const seen = new Set<string>()
  let depth = 0
  while (causationRef !== undefined) {
    if (seen.has(causationRef)) {
      return undefined
    }
    seen.add(causationRef)

    const jobRun = input.store.getJobRun(causationRef).jobRun
    if (jobRun === undefined) {
      return undefined
    }
    if (jobRun.jobId === input.candidateJobId) {
      return 'causation_cycle'
    }

    depth += 1
    if (depth > input.depthLimit) {
      return 'causation_depth'
    }

    const sourceEventId = readSourceCanonicalEventId(jobRun.source)
    if (sourceEventId === undefined) {
      return undefined
    }
    const sourceEvent = input.store.getInboxEvent(sourceEventId).event
    if (sourceEvent === undefined) {
      return undefined
    }
    const parsed = parseAcpWebhookEvent(sourceEvent.payload)
    if (!parsed.ok) {
      return undefined
    }
    causationRef = readCausationRef(parsed.event)
  }

  return undefined
}

function readCausationRef(event: AcpWebhookEvent): string | undefined {
  const value = event.origin?.causation_ref
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readSourceCanonicalEventId(
  source: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  if (source === undefined || source['kind'] !== 'webhook') {
    return undefined
  }
  const canonicalEventId = source['canonicalEventId']
  if (typeof canonicalEventId === 'string' && canonicalEventId.trim().length > 0) {
    return canonicalEventId.trim()
  }
  const sourceName = source['source']
  const eventId = source['eventId']
  return typeof sourceName === 'string' &&
    sourceName.trim().length > 0 &&
    typeof eventId === 'string' &&
    eventId.trim().length > 0
    ? `${sourceName.trim()}:${eventId.trim()}`
    : undefined
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
