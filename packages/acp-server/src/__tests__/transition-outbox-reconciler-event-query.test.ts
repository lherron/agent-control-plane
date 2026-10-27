/**
 * Transition-outbox replay-feed acceptance (T-04794 / T-04763 C-04677).
 * Every eligible durable transition produces exactly one tester handoff/wake,
 * including across scan/drain crash windows and concurrent replay.
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
import { reconcileTransitionOutbox } from '../integration/transition-outbox-reconciler.js'

// Use the production input contract, without a cast that could mask drift.
const reconcileViaEventQuery = reconcileTransitionOutbox

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
    principal_ref: `agent:${ACTOR_AGENT_ID}`,
    role: 'implementer',
    // Populated by wrkf server when boundRole='tester' + includeRoleBindings=true
    matchingRoleBindings: [
      {
        instanceId: `wfi_${overrides.id.toLowerCase()}_test`,
        role: 'tester',
        principal_ref: `agent:${TESTER_AGENT_ID}`,
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
// The reconciler scans wrkf.event.query with the canonical filter set; that
// outbound request at the wrkf boundary IS the scan behavior.

describe('Section 0 — API contract: reconciler calls wrkf.event.query with canonical params', () => {
  test('reconcile scans wrkf for bound-tester red->green transitions excluding low risk, with a bounded limit', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([]) }])

    await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      eventType: 'workflow.transitioned',
      fromPhase: 'red',
      toPhase: 'green',
      excludeRiskClass: 'low',
      boundRole: 'tester',
      includeRoleBindings: true,
      limit: 100,
    })
  })
})

// ─── Section 1: Repair missing outbox ────────────────────────────────────────
//
// A red→green transition committed in wrkq but with NO ACP outbox entry
// (e.g. ACP was down when it committed) must be enqueued by the reconciler.
// This is the PRIMARY invariant — the REPLAY FEED property of event.query.

describe('Section 1 — Repair missing outbox: event in wrkf.event.query, no outbox → reconciler enqueues one', () => {
  test('scanned transition becomes one outbox row keyed by event id with task, project, phases and tester from role bindings', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    expect(stateStore.transitionOutbox.get(EVENT_A.id)).toMatchObject({
      transitionEventId: EVENT_A.id,
      taskId: EVENT_A.task.id,
      projectId: PROJECT_ID,
      fromPhase: 'red',
      toPhase: 'green',
      // testerAgentId is the agent slug from matchingRoleBindings ("agent:" stripped)
      payload: {
        testerAgentId: TESTER_AGENT_ID,
        actor: { agentId: ACTOR_AGENT_ID },
      },
    })
  })

  test('rescanning the same event enqueues nothing and leaves one declared handoff', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A]) },
      { result: queryResult([EVENT_A]) }, // same event on second scan
    ])

    const first = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })
    const second = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    expect(first.enqueued).toBe(1)
    // The re-scan sees the existing outbox row and skips it.
    expect(second.enqueued).toBe(0)
    const handoffs = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID }).filter(
      (e) => e.kind === 'handoff.declared'
    )
    expect(handoffs).toHaveLength(1)
  })

  test('reconcile reports scanned and newly enqueued counts', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A, EVENT_B]) }])

    const result = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    expect(result).toMatchObject({ scanned: 2, enqueued: 2 })
  })
})

// ─── Section 3: Retry on coordination failure ─────────────────────────────────
//
// Coordination store throws on first drain → outbox entry stays non-delivered.
// Next reconcile call successfully drains. Tests the errored-then-retry path.

describe('Section 3 — Retry on coordination failure', () => {
  test('coordination write failure leaves the outbox row pending with the error; the next reconcile delivers and clears it', async () => {
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

    // First pass: coord fails → reconcile throws, row not delivered, error recorded.
    await expect(
      reconcileViaEventQuery({ wrkfEvent: facade1, stateStore, coordStore: brokenStore })
    ).rejects.toThrow('coord append exploded')
    const failed = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(failed?.status).not.toBe('delivered')
    expect(failed?.attempts).toBeGreaterThanOrEqual(1)
    expect(failed?.lastError).toContain('coord append exploded')

    // Second pass: coord works
    const { facade: facade2 } = makeFakeWrkfEvent([{ result: queryResult([]) }])
    await reconcileViaEventQuery({ wrkfEvent: facade2, stateStore, coordStore: realCoordStore })

    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.status).toBe('delivered')
    expect(entry?.attempts).toBeGreaterThanOrEqual(2)
    expect(entry?.lastError).toBeNull()
  })

  test('coord failures stop retrying after the outbox row becomes terminal failed', async () => {
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

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])
      const brokenStore = makeBrokenCoordStore(`coord append exploded ${attempt}`, realCoordStore)

      await expect(
        reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore: brokenStore })
      ).rejects.toThrow(`coord append exploded ${attempt}`)
    }

    expect(stateStore.transitionOutbox.get(EVENT_A.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'coord append exploded 3',
    })

    const { facade } = makeFakeWrkfEvent([{ result: queryResult([]) }])
    const result = await reconcileViaEventQuery({
      wrkfEvent: facade,
      stateStore,
      coordStore: realCoordStore,
    })

    expect(result.delivered).toEqual([])
    expect(listEvents(realCoordStore, { projectId: PROJECT_ID, taskId: TASK_ID })).toEqual([])
  })
})

// ─── Section 4: Concurrent-drain idempotency ─────────────────────────────────
//
// Daedalus required test #3 (T-04763 C-04677): two concurrent reconcile calls
// must not produce duplicate handoffs for the same transition-event id.
// The idempotencyKey on appendEvent keyed by transition-event id prevents duplicates.

describe('Section 4 — Concurrent-drain idempotency: no duplicate handoff for same event id', () => {
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

  test('two concurrent reconciles of the same transition produce one outbox row and one handoff', async () => {
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
})

// ─── Section 5: Cursor/limit paging ──────────────────────────────────────────
//
// wrkf.event.query returns hasMore=true with nextCursor → reconciler must
// fetch the next page using that cursor. The cursor is an opaque token (NOT
// the event id — real binary uses base64-encoded JSON pagination state).

describe('Section 5 — Cursor/limit paging over wrkf.event.query', () => {
  const NEXT_CURSOR =
    'eyJzb3J0X2ZpZWxkcyI6WyJjcmVhdGVkX2F0Il0sImxhc3RfdmFsdWVzIjpbIjIwMjYtMDYtMTVUMTA6MDA6MDBaIl0sImxhc3RfaWQiOiJ3ZmVfcDJjXzAwMSJ9'

  test('reconcile follows nextCursor to the second page and enqueues events from both pages', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade, calls } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A], { hasMore: true, nextCursor: NEXT_CURSOR }) },
      { result: queryResult([EVENT_B]) }, // second page with different event
    ])

    await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    // The second call uses the opaque cursor token (NOT the event id).
    expect(calls).toHaveLength(2)
    expect(calls[1]?.cursor).toBe(NEXT_CURSOR)
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

    await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    // Only one page fetched when hasMore=false
    expect(calls.length).toBe(1)
  })

  test('explicit scan limit is preserved on both pages', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    const { facade, calls } = makeFakeWrkfEvent([
      { result: queryResult([EVENT_A], { hasMore: true, nextCursor: NEXT_CURSOR }) },
      { result: queryResult([]) },
    ])

    await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore, limit: 50 })

    // Both pages must use the same limit
    expect(calls).toHaveLength(2)
    expect(calls[0]?.limit).toBe(50)
    expect(calls[1]?.limit).toBe(50)
  })
})

// ─── Section 6: Crash-recovery (the load-bearing replay-feed test) ────────────
//
// A transition committed to wrkq while ACP was "down" — ACP has NO record in
// its outbox. On the next reconcile scan, wrkf.event.query returns the event
// because it queries the DURABLE wrkq event log (not ACP-local state).
// THIS IS WHY we use event.query rather than ACP-local append.

describe('Section 6 — Crash-recovery: transition committed while ACP was down → reconciled on next scan', () => {
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

    const result = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    // The pending outbox entry must be drained to coordination
    expect(result.delivered.map((d) => d.transitionEventId)).toEqual([EVENT_A.id])
    const entry = stateStore.transitionOutbox.get(EVENT_A.id)
    expect(entry?.status).toBe('delivered')

    const events = listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })
    expect(events.filter((e) => e.kind === 'handoff.declared')).toHaveLength(1)

    // One wake for the tester session, deduped on the transition-event id.
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
    expect(wakes[0]?.sessionRef).toEqual(testerSessionRef)
    expect(wakes[0]?.dedupeKey).toBe(EVENT_A.id)
  })

  test('[RED] full end-to-end crash recovery: query returns event, reconciler scans + drains in one call', async () => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()

    // Nothing in ACP (total crash scenario)
    expect(stateStore.transitionOutbox.get(EVENT_A.id)).toBeUndefined()
    expect(listEvents(coordStore, { projectId: PROJECT_ID, taskId: TASK_ID })).toHaveLength(0)

    // wrkf.event.query returns the committed transition (replay feed)
    const { facade } = makeFakeWrkfEvent([{ result: queryResult([EVENT_A]) }])

    await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

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

describe('Section 7 — boundRole semantics: no forward tester binding → NOT enqueued', () => {
  test.each([
    // EVENT_NO_TESTER: matchingRoleBindings [] (server-filtered — no tester bound)
    { name: 'empty matchingRoleBindings', event: EVENT_NO_TESTER },
    // Real binary can return null for matchingRoleBindings (observed in real data)
    {
      name: 'null matchingRoleBindings',
      event: makeTransitionEvent({
        id: 'wfe_p2c_004',
        matchingRoleBindings: null as unknown as [],
      }),
    },
  ])('transition without a bound tester is not enqueued: $name', async ({ event }) => {
    const stateStore = openStateStore()
    const coordStore = openCoordStore()
    const { facade, calls } = makeFakeWrkfEvent([{ result: queryResult([event]) }])

    const result = await reconcileViaEventQuery({ wrkfEvent: facade, stateStore, coordStore })

    expect(calls).toHaveLength(1)
    expect(result.enqueued).toBe(0)
    expect(stateStore.transitionOutbox.get(event.id)).toBeUndefined()
  })
})
