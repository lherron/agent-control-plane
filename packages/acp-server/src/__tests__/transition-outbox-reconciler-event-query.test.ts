/**
 * RED TESTS — P2c: transition-outbox reconciler on wrkf.event.query (T-04794)
 *
 * All tests fail at runtime because reconcileTransitionOutbox still uses the
 * OLD raw-SQLite scan (prepared SQL on the wrkq store sqlite handle) instead of
 * wrkf.event.query.
 * We call the existing function with the NEW expected signature — it crashes
 * with "TypeError: Cannot read properties of undefined (reading 'sqlite')"
 * because input.wrkqStore is not supplied. That is the canonical RED signal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INVARIANT (daedalus — T-04763 C-04677, load-bearing):
 *
 * For every durable workflow.transitioned event with
 *   { from=red, to=green, task riskClass != 'low', tester role BOUND in the
 *     forward model (workflow_role_bindings) }
 * ACP eventually delivers EXACTLY ONE tester handoff/wake keyed by
 * transition-event-id, including after crashes between transition commit /
 * ACP outbox append / coordination append.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT (what P2c must produce):
 *
 * The existing reconcileTransitionOutbox signature changes from
 *   { wrkqStore: WrkqStore, stateStore, coordStore }
 * to
 *   { wrkfEvent: WrkfEventFacade, stateStore, coordStore, limit?: number }
 *
 * Where WrkfEventFacade = { query(params?: WrkfEventQueryParams): Promise<WrkfEventQueryResult> }
 *
 * Scan phase (replaces scanEligibleTransitions / the old raw-sqlite prepare):
 *   client.wrkf.event.query({
 *     eventType: 'workflow.transitioned',
 *     fromPhase: 'red',
 *     toPhase: 'green',
 *     excludeRiskClass: 'low',
 *     boundRole: 'tester',
 *     includeRoleBindings: true,
 *     limit: <limit>,
 *     cursor?: <nextCursor from previous page>,
 *   })
 *
 * Field mapping (WrkfTransitionEvent → outbox append):
 *   - outboxKey (idempotency):  event.id
 *   - taskId:                   event.task.id
 *   - projectId:                event.task.projectId
 *   - fromPhase:                event.fromPhase ?? ''
 *   - toPhase:                  event.toPhase
 *   - transitionTimestamp:      event.transitionedAt
 *   - actorAgentId:             event.actor stripped of "agent:" prefix
 *   - actorRole:                event.actorRole
 *   - testerAgentId:            matchingRoleBindings.find(b => b.role==='tester')?.actor,
 *                               stripped of "agent:" prefix
 *
 * ACTOR FORMAT: real binary returns "agent:larry" — strip prefix for agentId.
 * MATCHING BINDINGS: populated by wrkf server when boundRole + includeRoleBindings used.
 *
 * Drain phase: UNCHANGED (leaseNext → appendCoordination → markDelivered).
 * Cursor paging: pass nextCursor from first page as cursor on next query call.
 * Idempotency guard: stateStore.transitionOutbox.get(event.id) !== undefined → skip.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { type AcpStateStore, openAcpStateStore } from 'acp-state-store'
import {
  type CoordinationStore,
  listEvents,
  listPendingWakes,
  openCoordinationStore,
} from 'coordination-substrate'

import type { WrkfEventQueryParams, WrkfEventQueryResult, WrkfTransitionEvent } from '@wrkq/client'

import { buildTesterSessionRef } from '../integration/handoff-on-transition.js'
import {
  type ReconcileTransitionOutboxResult,
  reconcileTransitionOutbox,
} from '../integration/transition-outbox-reconciler.js'

// ─── NEW expected input type (P2c shape — what the impl WILL accept after rewrite) ──

/**
 * The new P2c reconciler input.
 * Currently the real function takes { wrkqStore, stateStore, coordStore }.
 * After P2c it will take this shape instead.
 */
type ReconcileViaEventQueryInput = {
  /** RPC facade: replaces WrkqStore.sqlite.prepare scanEligibleTransitions */
  wrkfEvent: { query(params?: WrkfEventQueryParams): Promise<WrkfEventQueryResult> }
  stateStore: AcpStateStore
  coordStore: CoordinationStore
  /** Optional limit cap for both scan and drain. Defaults to 100. */
  limit?: number
}

/**
 * Cast the existing reconcileTransitionOutbox to the expected P2c signature.
 *
 * RED: calling this with the new params fails at runtime because the current
 * impl calls input.wrkqStore's raw sqlite prepare(...) and wrkqStore is undefined.
 * That TypeError IS the red failure — it proves the impl still uses raw SQLite.
 */
const reconcileViaEventQuery = reconcileTransitionOutbox as unknown as (
  input: ReconcileViaEventQueryInput
) => Promise<ReconcileTransitionOutboxResult>

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const cleanupPaths: string[] = []

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

// ─── Fixture factories ────────────────────────────────────────────────────────

function openStateStore(): AcpStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'acp-p2c-state-'))
  cleanupPaths.push(dir)
  return openAcpStateStore({ dbPath: join(dir, 'acp-state.db') })
}

function openCoordStore(): CoordinationStore {
  const dir = mkdtempSync(join(tmpdir(), 'acp-p2c-coord-'))
  cleanupPaths.push(dir)
  return openCoordinationStore(join(dir, 'acp-coord.db'))
}

// ─── Canned WrkfTransitionEvent fixtures ─────────────────────────────────────
//
// All events use the REAL binary field shapes (actor prefixed "agent:",
// matchingRoleBindings from boundRole + includeRoleBindings=true).

const PROJECT_ID = 'P-00223'
const TASK_ID = 'T-04001'
const TASK_ID_2 = 'T-04002'
const TESTER_AGENT_ID = 'smokey'
const ACTOR_AGENT_ID = 'larry'

/** Build a canned WrkfTransitionEvent with tester binding in matchingRoleBindings */
function makeTransitionEvent(
  overrides: Partial<WrkfTransitionEvent> & { id: string }
): WrkfTransitionEvent {
  return {
    eventType: 'workflow.transitioned',
    instanceId: `wfi_${overrides.id.toLowerCase()}_test`,
    seq: 3,
    task: {
      uuid: 'a1b2c3d4-0000-0000-0000-000000000001',
      id: TASK_ID,
      slug: 'test-task',
      ref: `wrkq:${TASK_ID}`,
      projectUuid: 'b2c3d4e5-0000-0000-0000-000000000002',
      projectId: PROJECT_ID,
      projectSlug: 'agent-control-plane',
      riskClass: 'medium',
    },
    transition: 'submit_tests',
    outcome: 'implemented',
    from: { status: 'active', phase: 'red' },
    to: { status: 'active', phase: 'green' },
    fromPhase: 'red',
    toPhase: 'green',
    transitionedAt: '2026-06-15T10:00:00Z',
    actor: `agent:${ACTOR_AGENT_ID}`,
    actorRole: 'implementer',
    // Populated by wrkf server when boundRole='tester' + includeRoleBindings=true
    matchingRoleBindings: [
      {
        instanceId: `wfi_${overrides.id.toLowerCase()}_test`,
        role: 'tester',
        actor: `agent:${TESTER_AGENT_ID}`,
        bindingMode: 'required',
        boundAt: '2026-06-15T09:00:00Z',
      },
    ],
    payload: {
      from: { status: 'active', phase: 'red' },
      to: { status: 'active', phase: 'green' },
      transition: 'submit_tests',
      outcome: 'implemented',
    },
    ...overrides,
  }
}

const EVENT_A = makeTransitionEvent({ id: 'wfe_p2c_001' })
const EVENT_B = makeTransitionEvent({
  id: 'wfe_p2c_002',
  task: { ...makeTransitionEvent({ id: 'wfe_p2c_002' }).task, id: TASK_ID_2 },
})

/** Event with NO matching tester binding (forward role model: tester not bound) */
const EVENT_NO_TESTER = makeTransitionEvent({
  id: 'wfe_p2c_003',
  matchingRoleBindings: [],
})

/** Build a minimal success query result with given events */
function queryResult(
  items: WrkfTransitionEvent[],
  opts: { hasMore?: boolean; nextCursor?: string } = {}
): WrkfEventQueryResult {
  return {
    items,
    hasMore: opts.hasMore ?? false,
    nextCursor: opts.nextCursor,
  }
}

/** Fake WrkfEventFacade with configurable page responses */
type PagedResponse = {
  result: WrkfEventQueryResult
  assertParams?: (p: WrkfEventQueryParams) => void
}

function makeFakeWrkfEvent(pages: PagedResponse[]): {
  facade: { query(params?: WrkfEventQueryParams): Promise<WrkfEventQueryResult> }
  calls: WrkfEventQueryParams[]
} {
  const calls: WrkfEventQueryParams[] = []
  let pageIndex = 0

  return {
    facade: {
      async query(params: WrkfEventQueryParams = {}): Promise<WrkfEventQueryResult> {
        calls.push(params)
        const page = pages[pageIndex]
        if (page === undefined) {
          return queryResult([])
        }
        page.assertParams?.(params)
        pageIndex += 1
        return page.result
      },
    },
    calls,
  }
}

/** Build a failing coord store that throws on any write */
function makeBrokenCoordStore(message: string, real: CoordinationStore): CoordinationStore {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'sqlite') {
        return new Proxy((target as unknown as { sqlite: object }).sqlite, {
          get(_t, sqliteProp) {
            if (sqliteProp === 'transaction') {
              return () => () => {
                throw new Error(message)
              }
            }
            // Pass reads (e.g. the idempotency precheck's query/prepare) through
            // to the real sqlite, BOUND to it — bun:sqlite methods use private
            // fields and break if invoked with the Proxy as `this`. Only the
            // write transaction is rigged to throw.
            const value = Reflect.get(_t, sqliteProp)
            return typeof value === 'function' ? value.bind(_t) : value
          },
        })
      }
      return Reflect.get(target, prop)
    },
  }) as CoordinationStore
}

// ─── Section 0: API contract — correct query params ───────────────────────────
//
// The P2c reconciler MUST call wrkf.event.query with the canonical filter set.
// Tests fail because the current impl never calls wrkfEvent.query at all.

describe('Section 0 — API contract: reconciler calls wrkf.event.query with canonical params (P2c red)', () => {
  test('[RED] wrkf.event.query called with eventType workflow.transitioned', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // After P2c: query must be called; currently never reached → 0 calls
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]?.eventType).toBe('workflow.transitioned')
  })

  test('[RED] query params include fromPhase=red, toPhase=green', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(calls[0]?.fromPhase).toBe('red')
    expect(calls[0]?.toPhase).toBe('green')
  })

  test('[RED] query params include excludeRiskClass=low (server-side filter, no client re-check)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(calls[0]?.excludeRiskClass).toBe('low')
  })

  test('[RED] query params include boundRole=tester (forward role model eligibility)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(calls[0]?.boundRole).toBe('tester')
  })

  test('[RED] query params include includeRoleBindings=true (to populate matchingRoleBindings)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(calls[0]?.includeRoleBindings).toBe(true)
  })

  test('[RED] query params include a limit (not unbounded)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // limit must be set and positive (default 100, max 500 per wrkq docs)
    const limit = calls[0]?.limit
    expect(typeof limit).toBe('number')
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThanOrEqual(500)
  })
})

// ─── Section 1: Repair missing outbox ────────────────────────────────────────
//
// A red→green transition committed in wrkq but with NO ACP outbox entry
// (e.g. ACP was down when it committed) must be enqueued by the reconciler.
// This is the PRIMARY invariant — the REPLAY FEED property of event.query.

describe('Section 1 — Repair missing outbox: event in wrkf.event.query, no outbox → reconciler enqueues one (P2c red)', () => {
  test('[RED] event with tester bound → exactly one outbox entry keyed by transition-event id', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // After P2c: outbox entry enqueued for event.id
    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry).toBeDefined()
  })

  test('[RED] outbox entry is keyed by transition-event id (event.id), not task.id', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.transitionEventId).toBe(EVENT_A.id)
    expect(entry?.taskId).toBe(EVENT_A.task.id)
  })

  test('[RED] outbox entry carries projectId from event.task.projectId', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.projectId).toBe(PROJECT_ID)
  })

  test('[RED] outbox entry carries fromPhase and toPhase from the event', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.fromPhase).toBe('red')
    expect(entry?.toPhase).toBe('green')
  })

  test('[RED] outbox entry payload.testerAgentId from matchingRoleBindings (not task_role_assignments)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    const payload = entry?.payload as Record<string, unknown> | undefined
    // testerAgentId must be the agent slug extracted from matchingRoleBindings
    expect(payload?.['testerAgentId']).toBe(TESTER_AGENT_ID)
  })

  test('[RED] second reconcile call does not enqueue a second outbox entry (idempotent append)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A]) },
      { result: queryResult([EVENT_A]) }, // same event on second scan
    ])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // TransitionOutboxRepo.append is idempotent by transitionEventId
    // Only ONE outbox row must exist after two scans of the same event
    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry).toBeDefined()
    // Verify there's only one by checking status (if two were appended, the test
    // would still show one because append is idempotent — this just confirms the contract)
    expect(entry?.transitionEventId).toBe(EVENT_A.id)
  })

  test('[RED] scanned count in result equals number of events returned by query', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A, EVENT_B]) }])

    let result: ReconcileTransitionOutboxResult | undefined
    try {
      result = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(result?.scanned).toBe(2)
  })

  test('[RED] enqueued count in result equals number of newly enqueued entries', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    let result: ReconcileTransitionOutboxResult | undefined
    try {
      result = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(result?.enqueued).toBe(1)
  })
})

// ─── Section 2: Drain pending outbox ─────────────────────────────────────────
//
// An outbox entry pre-seeded (from a prior scan or crash recovery) is drained
// into the coordination store. The drain side behavior is unchanged from the
// current impl; these tests pin that behavior survives the P2c rewrite.

describe('Section 2 — Drain pending outbox: pre-seeded entry → coordination event appended (P2c red)', () => {
  test('[RED] pending outbox entry → handoff.declared event in coordination store', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // Pre-seed the outbox (simulating a prior scan or crash-recovery that appended)
    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    // wrkfEvent.query returns empty (the repair scan doesn't re-enqueue)
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
    expect(events.length).toBeGreaterThanOrEqual(1)
    const handoffEvent = events.find((e) => e.kind === 'handoff.declared')
    expect(handoffEvent).toBeDefined()
  })

  test('[RED] pending outbox entry → wake request created for tester session', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const testerSessionRef = buildTesterSessionRef({
      testerAgentId: TESTER_AGENT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    })
    const wakes = listPendingWakes(coordStore, {
      projectId: PROJECT_ID,
      sessionRef: testerSessionRef,
    })
    expect(wakes.length).toBeGreaterThanOrEqual(1)
    expect(wakes[0]?.sessionRef).toEqual(testerSessionRef)
  })

  test('[RED] outbox entry is marked delivered after successful drain', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.status).toBe('delivered')
  })

  test('[RED] delivered count in result equals number of entries drained', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    let result: ReconcileTransitionOutboxResult | undefined
    try {
      result = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(result?.delivered).toHaveLength(1)
    expect(result?.delivered[0]?.transitionEventId).toBe(EVENT_A.id)
  })
})

// ─── Section 3: Retry on coordination failure ─────────────────────────────────
//
// Coordination store throws on first drain → outbox entry stays non-delivered.
// Next reconcile call successfully drains. Tests the errored-then-retry path.

describe('Section 3 — Retry on coordination failure (P2c red)', () => {
  test('[RED] coord failure on drain → reconcile throws and outbox is NOT marked delivered', async () => {
    const stateStore = openStateStore()
    const realCoordStore = openCoordStore()
    const brokenStore = makeBrokenCoordStore('coord append exploded', realCoordStore)

    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    await expect(
      reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore: brokenStore })
    ).rejects.toThrow('coord append exploded')

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.status).not.toBe('delivered')
    expect(entry?.attempts).toBeGreaterThanOrEqual(1)
    expect(entry?.lastError).toContain('coord append exploded')
  })

  test('[RED] coord failure on first drain → second reconcile succeeds and delivers', async () => {
    const stateStore = openStateStore()
    const realCoordStore = openCoordStore()

    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    const { facade: facade1 } = makeFakeWrkfEvent([{ result: queryResult([]) }])
    const brokenStore = makeBrokenCoordStore('coord append exploded', realCoordStore)

    // First pass: coord fails
    try {
      await reconcileViaEventQuery({ wrkfEvent: facade1, stateStore, coordStore: brokenStore })
    } catch {
      /* expected */
    }

    // Second pass: coord works
    const { facade: facade2 } = makeFakeWrkfEvent([{ result: queryResult([]) }])
    try {
      await reconcileViaEventQuery({ wrkfEvent: facade2, stateStore, coordStore: realCoordStore })
    } catch {
      /* expected to fail — RED */
    }

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.status).toBe('delivered')
    expect(entry?.attempts).toBeGreaterThanOrEqual(2)
    expect(entry?.lastError).toBeNull()
  })
})

// ─── Section 4: Concurrent-drain idempotency ─────────────────────────────────
//
// Daedalus required test #3 (T-04763 C-04677): two concurrent reconcile calls
// must not produce duplicate handoffs for the same transition-event id.
// The idempotencyKey on appendEvent keyed by transition-event id prevents duplicates.

describe('Section 4 — Concurrent-drain idempotency: no duplicate handoff for same event id (P2c red)', () => {
  test('[RED] concurrent reconcile calls with same outbox entry → exactly one handoff.declared event', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    const { facade: facade1 } = makeFakeWrkfEvent([{ result: queryResult([]) }])
    const { facade: facade2 } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    await Promise.allSettled([
      reconcileViaEventQuery({ wrkfEvent: facade1, stateStore, coordStore }),
      reconcileViaEventQuery({ wrkfEvent: facade2, stateStore, coordStore }),
    ])

    // Idempotency via idempotencyKey on appendEvent prevents duplicate events
    const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
    const handoffEvents = events.filter((e) => e.kind === 'handoff.declared')
    expect(handoffEvents).toHaveLength(1)
  })

  test('[RED] concurrent reconcile with same event from query → at most one outbox entry, one handoff', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // Both reconcilers see the same event from wrkfEvent.query (scan phase)
    const { facade: facade1 } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])
    const { facade: facade2 } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    await Promise.allSettled([
      reconcileViaEventQuery({ wrkfEvent: facade1, stateStore, coordStore }),
      reconcileViaEventQuery({ wrkfEvent: facade2, stateStore, coordStore }),
    ])

    // Only one outbox entry (idempotent append)
    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry).toBeDefined()

    // Only one coordination event (idempotency key guards against duplicate drain)
    const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
    const handoffEvents = events.filter((e) => e.kind === 'handoff.declared')
    expect(handoffEvents).toHaveLength(1)
  })

  test('[RED] wake dedupeKey equals transition-event id (idempotency anchor)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const testerSessionRef = buildTesterSessionRef({
      testerAgentId: TESTER_AGENT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    })
    const wakes = listPendingWakes(coordStore, {
      projectId: PROJECT_ID,
      sessionRef: testerSessionRef,
    })
    const wake = wakes[0]
    // dedupeKey must be the transition-event id for idempotency
    expect(wake?.dedupeKey).toBe(EVENT_A.id)
  })
})

// ─── Section 5: Cursor/limit paging ──────────────────────────────────────────
//
// wrkf.event.query returns hasMore=true with nextCursor → reconciler must
// fetch the next page using that cursor. The cursor is an opaque token (NOT
// the event id — real binary uses base64-encoded JSON pagination state).

describe('Section 5 — Cursor/limit paging over wrkf.event.query (P2c red)', () => {
  const NEXT_CURSOR =
    'eyJzb3J0X2ZpZWxkcyI6WyJjcmVhdGVkX2F0Il0sImxhc3RfdmFsdWVzIjpbIjIwMjYtMDYtMTVUMTA6MDA6MDBaIl0sImxhc3RfaWQiOiJ3ZmVfcDJjXzAwMSJ9'

  test('[RED] when hasMore=true, reconciler calls query again with nextCursor', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade, calls } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A], { hasMore: true, nextCursor: NEXT_CURSOR }) },
      { result: queryResult([]) }, // second page: empty
    ])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // Must have made at least 2 query calls (first page + follow-up)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test('[RED] second page query uses the exact nextCursor token from first page', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade, calls } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A], { hasMore: true, nextCursor: NEXT_CURSOR }) },
      { result: queryResult([]) },
    ])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // The second call must use the cursor token (NOT the event id)
    const secondCall = calls[1]
    expect(secondCall?.cursor).toBe(NEXT_CURSOR)
  })

  test('[RED] multi-page scan enqueues all events from both pages', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A], { hasMore: true, nextCursor: NEXT_CURSOR }) },
      { result: queryResult([EVENT_B]) }, // second page with different event
    ])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // Both events from both pages must be enqueued
    expect(stateStore.transitionOutbox.get(EVENT_A.id)).toBeDefined()
    expect(stateStore.transitionOutbox.get(EVENT_B.id)).toBeDefined()
  })

  test('[RED] when hasMore=false, reconciler stops after one page (no unnecessary second call)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade, calls } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A], { hasMore: false }) },
    ])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // Only one page fetched when hasMore=false
    expect(calls.length).toBe(1)
  })

  test('[RED] limit passed to first-page query; subsequent pages use the same limit', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade, calls } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A], { hasMore: true, nextCursor: NEXT_CURSOR }) },
      { result: queryResult([]) },
    ])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore, limit: 50 })
    } catch {
      /* expected to fail — RED */
    }

    // Both pages must use the same limit
    expect(calls[0]?.limit).toBe(50)
    if (calls.length >= 2) {
      expect(calls[1]?.limit).toBe(50)
    }
  })
})

// ─── Section 6: Crash-recovery (the load-bearing replay-feed test) ────────────
//
// A transition committed to wrkq while ACP was "down" — ACP has NO record in
// its outbox. On the next reconcile scan, wrkf.event.query returns the event
// because it queries the DURABLE wrkq event log (not ACP-local state).
// THIS IS WHY we use event.query rather than ACP-local append.

describe('Section 6 — Crash-recovery: transition committed while ACP was down → reconciled on next scan (P2c red)', () => {
  test('[RED] transition event in wrkf.event.query with no ACP outbox → reconciler fills the gap', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // ACP has NO outbox entry for this event — simulates ACP being down when
    // the transition was committed to wrkq
    expect(stateStore.transitionOutbox.get(EVENT_A.id)).toBeUndefined()

    // wrkf.event.query DOES return the event (durable replay feed from wrkq)
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // After P2c: the reconciler bridges the gap — outbox entry created and drained
    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry).toBeDefined()
  })

  test('[RED] crash between outbox append and coord append → next scan re-drains from outbox', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // Simulate partial crash: outbox entry exists (appended) but coord never received it
    stateStore.transitionOutbox.append({
      transitionEventId: EVENT_A.id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      payload: {
        transitionTimestamp: '2026-06-15T10:00:00Z',
        actor: { agentId: ACTOR_AGENT_ID, role: 'implementer' },
        testerAgentId: TESTER_AGENT_ID,
      },
    })

    // wrkf.event.query returns empty (scan won't re-enqueue, it's already in outbox)
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // The pending outbox entry must be drained to coordination
    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.status).toBe('delivered')

    const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
    expect(events.find((e) => e.kind === 'handoff.declared')).toBeDefined()
  })

  test('[RED] full end-to-end crash recovery: query returns event, reconciler scans + drains in one call', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // Nothing in ACP (total crash scenario)
    expect(stateStore.transitionOutbox.get(EVENT_A.id)).toBeUndefined()
    expect(listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })).toHaveLength(0)

    // wrkf.event.query returns the committed transition (replay feed)
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // After P2c: the reconciler discovers the event, enqueues it, and drains it
    // in a single reconcile call — achieving full crash recovery
    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.status).toBe('delivered')

    const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
    const handoffEvent = events.find((e) => e.kind === 'handoff.declared')
    expect(handoffEvent).toBeDefined()

    const testerSessionRef = buildTesterSessionRef({
      testerAgentId: TESTER_AGENT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    })
    const wakes = listPendingWakes(coordStore, {
      projectId: PROJECT_ID,
      sessionRef: testerSessionRef,
    })
    expect(wakes).toHaveLength(1)
    expect(wakes[0]?.state).toBe('queued')
  })
})

// ─── Section 7: boundRole semantics (forward role model) ─────────────────────
//
// The old reconciler scanned task_role_assignments (legacy). P2c uses the
// forward model (workflow_role_bindings) via boundRole + matchingRoleBindings.
// A red→green event WITHOUT a tester binding in the forward model must NOT
// be enqueued — even if the old task_role_assignments table had a tester.

describe('Section 7 — boundRole semantics: no forward tester binding → NOT enqueued (P2c red)', () => {
  test('[RED] event with empty matchingRoleBindings (no tester in forward model) → not enqueued', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // EVENT_NO_TESTER has matchingRoleBindings: [] (server-filtered — no tester bound)
    // Note: in practice, wrkf.event.query with boundRole='tester' would exclude this
    // event server-side. This test guards against the case where the server incorrectly
    // returns it or the client receives a null matchingRoleBindings on a different call.
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([EVENT_NO_TESTER]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // Guard: the query must have been called (RED guard — current impl never calls it)
    expect(calls.length).toBeGreaterThanOrEqual(1)
    // Must NOT be enqueued — no forward tester binding
    const entry = stateStore.transitionOutbox.get(EVENT_NO_TESTER.id)
    expect(entry).toBeUndefined()
  })

  test('[RED] event with tester in matchingRoleBindings → IS enqueued (forward model positive case)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // EVENT_A has matchingRoleBindings with tester bound
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry).toBeDefined()
  })

  test('[RED] null matchingRoleBindings → NOT enqueued (server returned null instead of empty array)', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // Real binary can return null for matchingRoleBindings (observed in real data)
    const eventWithNullBindings = makeTransitionEvent({
      id: 'wfe_p2c_004',
      matchingRoleBindings: null as unknown as [],
    })

    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([eventWithNullBindings]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    // Guard: the query must have been called (RED guard — current impl never calls it)
    expect(calls.length).toBeGreaterThanOrEqual(1)
    // null matchingRoleBindings means no tester bound → must not enqueue
    const entry = stateStore.transitionOutbox.get(eventWithNullBindings.id)
    expect(entry).toBeUndefined()
  })

  test('[RED] mixed events: tester-bound enqueued, unbound skipped', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A, EVENT_NO_TESTER]) }])

    try {
      await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    } catch {
      /* expected to fail — RED */
    }

    expect(stateStore.transitionOutbox.get(EVENT_A.id)).toBeDefined()
    expect(stateStore.transitionOutbox.get(EVENT_NO_TESTER.id)).toBeUndefined()
  })
})
