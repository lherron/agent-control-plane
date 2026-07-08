/**
 * T-04893 RED A — managed event-hook ISO-cooldown enforcement.
 *
 * THE BUG:
 *   validateManagedJobTrigger (managed-resources.ts:231-256) normalizes the ISO
 *   "PT300S" cooldown → "300s" so that validateJobTrigger passes, then
 *   RE-OVERRIDES result.trigger.cooldown back to the raw "PT300S" (line 254).
 *   The runtime evaluator calls parseDurationToMs(trigger.cooldown) which returns
 *   undefined for "PT300S", so cooldownMs stays undefined, and the cooldown guard
 *   at scheduler.ts:131-148 is NEVER reached.  A second matching event within the
 *   PT300S window admits a SECOND turn.
 *
 * RED A-1 (unit): apply an event-hook with ISO cooldown "PT300S"; assert that the
 *   resulting persisted trigger.cooldown satisfies parseDurationToMs(cooldown) > 0.
 *   FAILS NOW: the re-override yields "PT300S" → parseDurationToMs returns undefined.
 *
 * RED A-2 (integration): apply the same managed event-hook, fire TWO matching events
 *   within PT300S, assert exactly ONE turn minted (second skipped reason=cooldown).
 *   FAILS NOW: cooldownMs=undefined → guard skipped → second event also minted.
 *
 * Both tests go GREEN when validateManagedJobTrigger no longer re-overrides with the
 * raw ISO value — i.e. returns the normalised "300s" form from the store.
 */
import { describe, expect, test } from 'bun:test'

import {
  adaptWrkqWebhookEvent,
  evaluateEventMatch,
  isAgentOriginEvent,
  parseAcpWebhookEvent,
  parseDurationToMs,
  resolveEventAction,
} from 'acp-core'

import {
  type ApplyManagedJobInput,
  type EvaluateEventJob,
  type JobsStore,
  applyManagedJob,
  createInMemoryJobsStore,
  tickJobsScheduler,
} from '../index.js'

// ---------------------------------------------------------------------------
// Fixture: an event-hook with an ISO-format cooldown (as the ASP compiler emits)
// ---------------------------------------------------------------------------

const NOW = '2026-06-17T22:00:00.000Z'

/**
 * A managed event-hook whose trigger.cooldown is "PT300S" — the exact form that the
 * ASP compiler currently emits.  applyManagedJob accepts it (via normalisation shim)
 * but silently re-stores the unparseable ISO value, disabling the cooldown at runtime.
 */
const EVENT_HOOK_ISO_COOLDOWN: ApplyManagedJobInput = {
  projectionId:
    'agent-directory:agent:smokey:project:agent-spaces:event-hook:wrkq-smoketest-cd-bug',
  projectionPk: 'agent-smokey.wrkq-smoketest-cd-bug',
  sourceOwnerScopeRef: 'agent:smokey:project:agent-spaces',
  resourceName: 'wrkq-smoketest-cd-bug',
  sourcePath: 'agents/smokey/event-hooks/wrkq-smoketest-cd-bug.toml',
  sourceHash: 'sha256-canonical-json/v1:test-cd-bug-source-hash',
  desiredProjectionHash: 'sha256-canonical-json/v1:test-cd-bug-desired-hash',
  desiredJson: {
    kind: 'event-triggered-job',
    slug: 'agent-smokey.wrkq-smoketest-cd-bug',
    projectId: 'agent-spaces',
    agentId: 'smokey',
    scopeRef: 'agent:smokey:project:agent-spaces:task:{{ticket_id}}',
    laneRef: 'main',
    title: 'Cooldown-bug regression event-hook',
    disabled: false,
    trigger: {
      kind: 'event',
      source: 'wrkq',
      match: { event: 'created', transition: { to: 'idea' } },
      cooldown: 'PT300S', // ISO 8601 — silently breaks at runtime (see bug above)
      originPolicy: { agent: 'deny' },
    },
    input: { content: 'Handle {{ticket_id}}.' },
  },
  resourceKind: 'event-hook',
  now: NOW,
}

/** A minimal wrkq event payload that satisfies the event-hook's trigger.match. */
const wrkqEvent = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 2,
  event_id: 'evt_cd1',
  event_seq: 1,
  event: 'created',
  occurred_at: '2026-06-17T22:00:00Z',
  origin: { actor: 'human:lance', via: 'cli' },
  ticket_id: 'T-00099',
  project_scope_id: 'agent-spaces',
  transition: { from: null, to: 'idea' },
  ...overrides,
})

/**
 * Faithful mirror of acp-server's injected evaluateEventJob — same logic as
 * event-jobs.test.ts.  Key path: parseDurationToMs(trigger.cooldown) propagates
 * the cooldown to the scheduler; if parseDurationToMs returns undefined (as it does
 * for "PT300S"), cooldownMs is absent and the scheduler skips the cooldown guard.
 */
const evaluateEventJob: EvaluateEventJob = ({ job, event }) => {
  const trigger = job.trigger
  if (trigger.kind !== 'event') return { decision: 'skip', reason: 'match_false' }
  const parsed = parseAcpWebhookEvent(event.payload)
  if (!parsed.ok) return { decision: 'skip', reason: 'match_false' }
  if (trigger.source !== parsed.event.source) return { decision: 'skip', reason: 'match_false' }
  if (!evaluateEventMatch(trigger.match, parsed.event))
    return { decision: 'skip', reason: 'match_false' }
  const agentPolicy = trigger.originPolicy?.agent ?? 'deny-self'
  if (agentPolicy === 'deny' && isAgentOriginEvent(parsed.event))
    return { decision: 'skip', reason: 'agent_origin_blocked' }
  if (agentPolicy === 'deny-self' && isSelfAgentOrigin(parsed.event, job.agentId))
    return { decision: 'skip', reason: 'agent_origin_blocked' }
  const resolved = resolveEventAction({
    scopeRefTemplate: job.scopeRef,
    laneRefTemplate: job.laneRef,
    inputTemplate: job.input,
    event: parsed.event,
  })
  if (!resolved.ok) return { decision: 'skip', reason: 'template_error' }
  // THE CRITICAL PATH: if trigger.cooldown is "PT300S", parseDurationToMs returns undefined
  // → cooldownMs is absent from the returned evaluation → scheduler guard is skipped.
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
      source: parsed.event.source,
      eventId: parsed.event.event_id,
      canonicalEventId: parsed.event.canonical_event_id,
      eventSeq: parsed.event.event_seq,
    },
    targetTaskId: resolved.resolved.targetKey,
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  }
}

function isSelfAgentOrigin(
  event: { origin?: { actor?: string; kind?: string } },
  jobAgentId: string
): boolean {
  const actor = event.origin?.actor
  const agentId = typeof actor === 'string' ? /^agent:([^:]+)$/.exec(actor)?.[1] : undefined
  if (agentId !== undefined) {
    return agentId === jobAgentId
  }
  return event.origin?.kind === 'agent'
}

/** Ingest one event and drain the scheduler, returning the minted runs. */
async function ingestAndTick(
  store: JobsStore,
  payload: Readonly<Record<string, unknown>>,
  now: string
) {
  const parsed = parseAcpWebhookEvent(payload)
  const source = parsed.ok ? parsed.event.source : undefined
  store.insertInboxEvent({
    eventId: String(payload['event_id']),
    eventSeq: Number(payload['event_seq']),
    event: String(payload['event']),
    ...(source !== undefined ? { source } : {}),
    payload,
  })
  return tickJobsScheduler({
    store,
    now,
    evaluateEventJob,
    dispatchThroughInputs: async (input) => ({
      inputAttemptId: `ia_${input.jobRunId}`,
      runId: `run_${input.jobRunId}`,
    }),
  })
}

// ---------------------------------------------------------------------------
// RED A-1: unit — persisted trigger.cooldown must be runtime-parseable
// ---------------------------------------------------------------------------

describe('T-04893 RED A-1 — ISO cooldown persisted form must be runtime-parseable', () => {
  test('managed event-hook "PT300S" cooldown: persisted trigger.cooldown satisfies parseDurationToMs > 0', () => {
    const store = createInMemoryJobsStore()
    const result = applyManagedJob(store, EVENT_HOOK_ISO_COOLDOWN)

    // applyManagedJob accepts the ISO cooldown (this assertion PASSES — the bug is silent)
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return

    expect(result.job.trigger.kind).toBe('event')
    if (result.job.trigger.kind !== 'event') return

    // Root-cause assertion:
    //   The persisted trigger.cooldown must be parseable by parseDurationToMs so the
    //   runtime evaluator (event-jobs line 50-51) can compute a finite cooldownMs.
    //   If parseDurationToMs returns undefined, the scheduler.ts:131 guard is silently
    //   skipped and every event within the window admits a new turn.
    //
    // FAILS NOW: managed-resources.ts:254 re-overrides with the raw "PT300S" value
    //   → parseDurationToMs("PT300S") returns undefined (not > 0).
    const cd = result.job.trigger.cooldown
    expect(cd).toBeDefined()
    expect(parseDurationToMs(cd!)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// RED A-2: integration — two events within PT300S must produce exactly ONE turn
// ---------------------------------------------------------------------------

describe('T-04893 RED A-2 — ISO-cooldown event-hook admits only ONE turn per window', () => {
  test('second matching event fired within PT300S is skipped reason=cooldown, not minted', async () => {
    const store = createInMemoryJobsStore()
    const applyResult = applyManagedJob(store, EVENT_HOOK_ISO_COOLDOWN)
    expect(applyResult.outcome).toBe('created')

    // Event 1 at T+0 s → minted (first turn)
    const runs1 = await ingestAndTick(
      store,
      adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'evt_cd1', event_seq: 1 })),
      '2026-06-17T22:00:00Z'
    )
    // First event always mints — this passes even now
    expect(runs1.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(1)

    // Event 2 at T+60 s — well within the PT300S = 300 s window.
    // Expected behaviour: skipped with reason=cooldown.
    //
    // FAILS NOW: "PT300S" → parseDurationToMs = undefined → cooldownMs absent from
    //   evaluation → scheduler.ts:131-148 guard is NEVER executed → second event is
    //   minted as a second turn (runs2 has length 1, not 0).
    const runs2 = await ingestAndTick(
      store,
      adaptWrkqWebhookEvent(wrkqEvent({ event_id: 'evt_cd2', event_seq: 2 })),
      '2026-06-17T22:01:00Z'
    )
    expect(runs2.filter((r) => r.triggeredBy === 'webhook')).toHaveLength(0) // FAILS NOW

    const matches = store.listEventJobMatches({ sourceEventId: 'wrkq:evt_cd2' }).matches
    expect(matches[0]?.outcome).toBe('skipped') // FAILS NOW (outcome='minted')
    expect(matches[0]?.reason).toBe('cooldown') // FAILS NOW (reason=null for minted)
  })
})
