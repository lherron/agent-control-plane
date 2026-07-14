/**
 * RED TESTS — W2a follow-up: wrkf real inspect shape vs handler fake-vs-real gap (T-01943)
 *
 * Root cause:
 *   handleGetWorkflowTask reads `inspected.task` and `inspected.instance` from
 *   wrkf.task.inspect(), but the REAL @wrkq/client.task.inspect() returns a FLAT object
 *   with NO task/instance wrapper. The old W2a fake returned canned {task, instance},
 *   masking this divergence. Result:
 *     - GET /v1/tasks/:taskId returns task: undefined / instance: undefined
 *     - `acp task show --task <wrkf-task>` (non-JSON) crashes on `task.taskId` (undefined)
 *
 * Real @wrkq/client shapes (captured from `wrkf task inspect T-01489 --json`):
 *
 *   task.inspect returns FLAT:
 *     keys = [id, taskUuid, taskRef, projectId, templateId, templateVersion, templateHash,
 *             status, phase, revision, taskDocEtag, taskDocHash, createdAt, updatedAt, suspension]
 *     NO 'task' key, NO 'instance' key
 *
 *   wrkf.next returns:
 *     { instance: {id,taskRef,template,state,revision,taskDoc,stale},
 *       actions: [...], blockedTransitions: [...], openObligations: [...], pendingEffects: [...] }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST KIND 1: Handler tests with real flat inspect shape (RED — must fail now)
 *
 *   Uses a fake deps.wrkf whose task.inspect returns the REAL FLAT shape (no task/instance
 *   wrapper). Assertions fail now because the handler reads inspected.task / inspected.instance
 *   (both undefined when the flat shape is returned), so body.task and body.instance are absent
 *   from the JSON response. Pass once impl maps the real inspect keys to the ACP projection.
 *
 * TEST KIND 2: Real-process @wrkq/client shape contract (fidelity guard)
 *
 *   Spins a real @wrkq/client against the canonical wrkq DB and asserts the actual top-level
 *   keys of task.inspect and next. These tests PASS now (they document reality). Their purpose
 *   is a fidelity guard: if the real client shape ever changes, these tests catch it; and they
 *   prevent future fakes from diverging silently (the old W2a fake was the root cause here).
 *   Requires: wrkf binary and canonical DB at ~/praesidium/var/db/wrkq.db; live task T-01489.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What the impl must change in packages/acp-server/src/handlers/workflow-tasks.ts:
 *
 *   1. DO NOT read inspected.task or inspected.instance — those keys don't exist in the
 *      real @wrkq/client response. inspected IS the instance record.
 *
 *   2. Build the `task` projection from the flat inspect fields:
 *        taskId     : use the :taskId route param (or parse from `inspected.taskRef`)
 *        projectId  : inspected.projectId   (NOTE: this is a UUID, not a wrkq project slug)
 *        workflow   : { id: inspected.templateId,
 *                       version: inspected.templateVersion,
 *                       hash: inspected.templateHash }
 *        state      : { status: inspected.status, phase: inspected.phase }
 *        version    : inspected.revision
 *        createdAt  : inspected.createdAt
 *        updatedAt  : inspected.updatedAt
 *        (goal and roleBindings are not in inspect; source from wrkq or omit with defaults)
 *
 *   3. Source `instance` from next.instance:
 *        const next = await wrkf.next({ task: taskId })
 *        // next.instance holds the full instance projection
 *        return json({ source:'wrkf', task, instance: next.instance, next, ... })
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import { createWrkfClientLifecycle } from '../wrkf/client-lifecycle.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_ID = 'T-WRKF02'
const WRKF_INSTANCE_ID = 'wfi_twrkf02_real_shape_test'

// ── Real flat inspect shape ────────────────────────────────────────────────────
//
// This matches the ACTUAL output of `wrkf task inspect T-01489 --json`.
// Keys: flat, no 'task' or 'instance' wrapper.

const REAL_FLAT_INSPECT = {
  id: WRKF_INSTANCE_ID,
  taskUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  taskRef: `wrkq:${TASK_ID}`,
  projectId: '6c774212-f2e4-47a5-a8bd-e91ab53df40a',
  templateId: 'agent_tasker_feature_request',
  templateVersion: '3',
  templateHash: 'sha256:7e0023770b40eb2f1f30126b5e8bffe815ddb23fe77dca0d0a40a8a3e00a5c13',
  status: 'active',
  phase: 'doing',
  revision: 5,
  taskDocEtag: '10',
  taskDocHash: 'sha256:ddeeff445566',
  createdAt: '2026-06-01T10:00:00Z',
  updatedAt: '2026-06-05T12:00:00Z',
  suspension: null,
}

// ── Real next shape ─────────────────────────────────────────────────────────────
//
// This matches the ACTUAL output of `wrkf next T-01489 --json`.
// instance sub-keys: [id, taskRef, template, state, revision, taskDoc, stale]

const REAL_NEXT_INSTANCE = {
  id: WRKF_INSTANCE_ID,
  taskRef: `wrkq:${TASK_ID}`,
  template: {
    id: 'agent_tasker_feature_request',
    version: '3',
    hash: 'sha256:7e0023770b40eb2f1f30126b5e8bffe815ddb23fe77dca0d0a40a8a3e00a5c13',
  },
  state: { status: 'active', phase: 'doing' },
  revision: 5,
  taskDoc: { etag: '10', hash: 'sha256:ddeeff445566' },
  stale: false,
}

const REAL_NEXT = {
  instance: REAL_NEXT_INSTANCE,
  actions: [],
  blockedTransitions: [],
  openObligations: [],
  pendingEffects: [],
}

// ── Real-shape fake port factory ────────────────────────────────────────────────
//
// task.inspect returns the REAL FLAT shape — no 'task' or 'instance' key.
// next returns the real {instance, actions, ...} shape.

function makeRealShapeWrkfPort(): AcpWrkfWorkflowPort {
  const notCalled = (name: string) => (): never => {
    throw new Error(`fake AcpWrkfWorkflowPort: ${name} must not be called in this test`)
  }
  return {
    workflow: {
      validate: notCalled('workflow.validate'),
      show: notCalled('workflow.show'),
      list: notCalled('workflow.list'),
      diff: notCalled('workflow.diff'),
      install: notCalled('workflow.install'),
    },
    task: {
      attach: notCalled('task.attach'),
      // KEY DIFFERENCE FROM OLD W2a FAKE:
      // Old fake returned: { task: CANNED_TASK, instance: CANNED_INSTANCE }
      // This fake returns: the REAL FLAT shape — id, taskUuid, taskRef, ... NO task/instance
      inspect: async (_params) => REAL_FLAT_INSPECT,
      timeline: async (_params) => [],
      refresh: notCalled('task.refresh'),
      syncMeta: notCalled('task.syncMeta'),
    },
    next: async (_params) => REAL_NEXT,
    evidence: {
      add: notCalled('evidence.add'),
      list: async (_params) => [],
      show: notCalled('evidence.show'),
      suggest: notCalled('evidence.suggest'),
    },
    obligation: {
      list: async (_params) => [],
      show: notCalled('obligation.show'),
      satisfy: notCalled('obligation.satisfy'),
      waive: notCalled('obligation.waive'),
      cancel: notCalled('obligation.cancel'),
    },
    transition: {
      apply: notCalled('transition.apply'),
    },
    run: {
      start: notCalled('run.start'),
      bindExternal: notCalled('run.bindExternal'),
      finish: notCalled('run.finish'),
      fail: notCalled('run.fail'),
      show: notCalled('run.show'),
      list: async (_params) => [],
    },
    effect: {
      list: async (_params) => [],
      show: notCalled('effect.show'),
      claim: notCalled('effect.claim'),
      ack: notCalled('effect.ack'),
      fail: notCalled('effect.fail'),
      retry: notCalled('effect.retry'),
      deliver: notCalled('effect.deliver'),
    },
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TEST KIND 1: Handler tests with real flat inspect shape (RED)
// ═════════════════════════════════════════════════════════════════════════════

describe('W2a real inspect shape — handler must project body.task from flat inspect keys (RED)', () => {
  // ── 1a. body.task must be defined ──────────────────────────────────────────
  //
  // RED because: handler reads `inspected.task` which is undefined when inspect
  // returns the flat shape (no .task key exists). JSON.stringify drops undefined
  // values, so body.task is absent from the response. The CLI crashes on:
  //   renderWorkflowTask(response.task)  →  task.taskId throws (task is undefined)
  //
  // GREEN when: handler builds task projection from flat inspect keys
  // (id/taskRef/templateId/templateVersion/templateHash/status/phase/revision etc.)
  // and body.task is a non-null object with a taskId.

  test('GET with real flat inspect shape: body.task is defined and has a taskId (RED: body.task is absent — handler reads inspected.task which is undefined)', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/tasks/${TASK_ID}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<{
          source: string
          task: { taskId: string } | undefined
        }>(response)
        expect(body.source).toBe('wrkf')
        // FAILS NOW:
        //   handler reads inspected.task (no .task key in flat shape → undefined)
        //   JSON serializes as absent → body.task === undefined
        expect(body.task).toBeDefined()
        expect(body.task?.taskId).toBe(TASK_ID)
      },
      { wrkf: makeRealShapeWrkfPort() }
    )
  })

  // ── 1b. body.task.workflow populated from template fields ──────────────────
  //
  // RED because: body.task is undefined (same root cause as 1a).
  // GREEN when: handler maps templateId → workflow.id, templateVersion → workflow.version,
  // templateHash → workflow.hash, status+phase → state, revision → version.

  test('GET with real flat inspect shape: body.task.workflow/state/version populated from templateId/status/revision (RED: body.task absent)', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/tasks/${TASK_ID}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<{
          task:
            | {
                taskId: string
                workflow: { id: string; version: string | number; hash: string }
                state: { status: string; phase: string }
                version: number
              }
            | undefined
        }>(response)
        // FAILS NOW: body.task is undefined (inspected.task is undefined)
        expect(body.task).toBeDefined()
        // After fix: template fields map to workflow sub-object
        expect(body.task?.workflow).toBeDefined()
        expect(body.task?.workflow.id).toBe(REAL_FLAT_INSPECT.templateId)
        expect(String(body.task?.workflow.version)).toBe(REAL_FLAT_INSPECT.templateVersion)
        expect(body.task?.workflow.hash).toBe(REAL_FLAT_INSPECT.templateHash)
        // status + phase → state
        expect(body.task?.state).toMatchObject({
          status: REAL_FLAT_INSPECT.status,
          phase: REAL_FLAT_INSPECT.phase,
        })
        // revision → version
        expect(body.task?.version).toBe(REAL_FLAT_INSPECT.revision)
      },
      { wrkf: makeRealShapeWrkfPort() }
    )
  })

  // ── 1c. body.instance sourced from next.instance ───────────────────────────
  //
  // RED because: handler reads `inspected.instance` which is undefined in the flat shape
  // (no .instance key). JSON.stringify drops it → body.instance is absent.
  // GREEN when: handler sources instance from next.instance (wrkf.next() → {instance,...}).
  // The next() call already exists and already returns REAL_NEXT which has .instance.

  test('GET with real flat inspect shape: body.instance sourced from next.instance (RED: body.instance absent — handler reads inspected.instance which is undefined)', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/tasks/${TASK_ID}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<{
          instance: { id: string; taskRef: string; revision: number } | undefined
        }>(response)
        // FAILS NOW:
        //   handler reads inspected.instance (no .instance key in flat shape → undefined)
        //   body.instance is absent; but next.instance IS available from wrkf.next()
        expect(body.instance).toBeDefined()
        expect(body.instance?.id).toBe(WRKF_INSTANCE_ID)
        expect(body.instance?.revision).toBe(REAL_FLAT_INSPECT.revision)
        expect(body.instance?.taskRef).toBe(`wrkq:${TASK_ID}`)
      },
      { wrkf: makeRealShapeWrkfPort() }
    )
  })

  // ── 1d. source field preserved (sanity / regression guard) ─────────────────
  //
  // This test PASSES now — source is set correctly regardless of inspect shape.
  // Included as a regression guard so we notice if source ever gets dropped.

  test('GET with real flat inspect shape: source field is preserved as "wrkf" (PASSES now — regression guard)', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/tasks/${TASK_ID}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<{ source: string }>(response)
        expect(body.source).toBe('wrkf')
      },
      { wrkf: makeRealShapeWrkfPort() }
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// TEST KIND 2: Real-process @wrkq/client shape contract (fidelity guard)
//
// These tests spin a REAL @wrkq/client subprocess against the canonical wrkq DB.
// They document the actual client shapes so future fakes can never silently diverge.
//
// Expected to PASS now (they observe reality, not assert what the handler does).
// They will FAIL if the live wrkf client changes its response shape — which is
// exactly what we want: a CI gate that catches shape drift.
//
// Requires:
//   - wrkf binary: ~/.local/bin/wrkf (or $WRKF_BIN)
//   - canonical DB: ~/praesidium/var/db/wrkq.db
//   - Live wrkf-backed task: T-01489, T-01500
// ═════════════════════════════════════════════════════════════════════════════

const WRKF_BINARY =
  process.env['WRKF_BIN'] ?? `${process.env['HOME'] ?? '/Users/lherron'}/.local/bin/wrkf`

const WRKQ_DB_PATH =
  process.env['WRKQ_DB_PATH'] ??
  `${process.env['HOME'] ?? '/Users/lherron'}/praesidium/var/db/wrkq.db`

const LIVE_TASK_ID = 'T-01489'

// Expected flat inspect keys (from live wrkf capture for T-01489 on 2026-07-14)
const EXPECTED_INSPECT_FLAT_KEYS = [
  'id',
  'taskUuid',
  'taskRef',
  'projectId',
  'templateId',
  'templateVersion',
  'templateHash',
  'status',
  'phase',
  'revision',
  'taskDocEtag',
  'taskDocHash',
  'createdAt',
  'updatedAt',
  'suspension',
] as const

// Expected next top-level keys (from live wrkf capture for T-01489 on 2026-07-14)
const EXPECTED_NEXT_TOP_KEYS = [
  'instance',
  'actions',
  'blockedTransitions',
  'openObligations',
  'pendingEffects',
] as const

// Expected next.instance sub-keys (from live wrkf capture for T-01489 on 2026-07-14)
const EXPECTED_INSTANCE_KEYS = [
  'id',
  'taskRef',
  'template',
  'state',
  'revision',
  'taskDoc',
  'stale',
] as const

describe('W2a real-process: @wrkq/client task.inspect + next shape contract (fidelity guard)', () => {
  // ── 2a. task.inspect returns FLAT — no task/instance wrapper ──────────────
  //
  // PASSES now (documenting reality). This is the FIDELITY GUARD:
  //   - Asserts the flat keys are present
  //   - Asserts 'task' and 'instance' are NOT present at top level
  //   - If wrkf changes its inspect shape, this test fails and we know about it
  //   - Prevents fakes from returning {task, instance} wrapper (the old W2a fake bug)

  test('REAL-PROCESS: task.inspect returns flat object — required keys present, NO task/instance wrapper', async () => {
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-real-shape', version: '0.1.0' },
    })
    try {
      const inspected = (await lc.wrkf!.task.inspect({ task: LIVE_TASK_ID })) as Record<
        string,
        unknown
      >
      const keys = Object.keys(inspected)

      // Exact-key guard: additions and removals are both provider contract drift.
      expect(keys.sort()).toEqual([...EXPECTED_INSPECT_FLAT_KEYS].sort())

      // FIDELITY GUARD: 'task' and 'instance' must NOT exist at top level.
      // The old W2a fake returned { task, instance } which masked this real-shape divergence.
      // If wrkf ever adds these keys, the handler mapping logic needs revisiting.
      expect(
        keys,
        "inspect result unexpectedly has a top-level 'task' wrapper — the old W2a fake bug recurred"
      ).not.toContain('task')
      expect(
        keys,
        "inspect result unexpectedly has a top-level 'instance' wrapper — the handler must source instance from next.instance, not inspect"
      ).not.toContain('instance')

      // taskRef must follow the wrkq: prefix format
      expect(String(inspected['taskRef'])).toBe(`wrkq:${LIVE_TASK_ID}`)

      // Sanity: revision must be a number (not a string)
      expect(typeof inspected['revision']).toBe('number')
    } finally {
      await lc.close()
    }
  }, 15000)

  // ── 2b. wrkf.next returns {instance, actions, ...} ────────────────────────
  //
  // PASSES now. Documents that the instance is under next.instance, not a top-level
  // key in inspect. The impl must source body.instance from next.instance.

  test('REAL-PROCESS: wrkf.next returns { instance, actions, blockedTransitions, openObligations, pendingEffects }', async () => {
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-real-shape', version: '0.1.0' },
    })
    try {
      const nextResult = (await lc.wrkf!.next({ task: LIVE_TASK_ID })) as Record<string, unknown>
      const keys = Object.keys(nextResult)

      // Exact-key guard: additions and removals are both provider contract drift.
      expect(keys.sort()).toEqual([...EXPECTED_NEXT_TOP_KEYS].sort())

      // instance is a nested object, not absent
      const instance = nextResult['instance'] as Record<string, unknown> | undefined
      expect(instance, 'next.instance must be a non-null object').toBeDefined()
      expect(typeof instance).toBe('object')
      expect(instance).not.toBeNull()

      const instanceKeys = Object.keys(instance!)
      expect(instanceKeys.sort()).toEqual([...EXPECTED_INSTANCE_KEYS].sort())

      // instance.taskRef binds back to the task
      expect(String(instance!['taskRef'])).toBe(`wrkq:${LIVE_TASK_ID}`)

      // instance does NOT have a nested 'task' wrapper
      expect(instanceKeys).not.toContain('task')
    } finally {
      await lc.close()
    }
  }, 15000)

  // ── 2c. inspect.id and next.instance.id are the same wrkf instance ─────────
  //
  // PASSES now. Documents that inspect.id === next.instance.id — both refer to the
  // same wrkf instance. The impl can use either as the authoritative instance id.

  test('REAL-PROCESS: inspect.id === next.instance.id (same wrkf instance, impl can use either)', async () => {
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-real-shape', version: '0.1.0' },
    })
    try {
      const [inspected, nextResult] = (await Promise.all([
        lc.wrkf!.task.inspect({ task: LIVE_TASK_ID }),
        lc.wrkf!.next({ task: LIVE_TASK_ID }),
      ])) as [Record<string, unknown>, Record<string, unknown>]

      const instance = nextResult['instance'] as Record<string, unknown>

      // Same wrkf instance ID in both responses
      expect(inspected['id']).toBe(instance['id'])
      expect(inspected['taskRef']).toBe(instance['taskRef'])
      // Revision is in both places (flat inspect and next.instance)
      expect(inspected['revision']).toBe(instance['revision'])
    } finally {
      await lc.close()
    }
  }, 15000)
})
