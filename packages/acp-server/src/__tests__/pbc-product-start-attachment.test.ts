// PBC product facade: start-attachment. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import {
  PBC_WORKFLOW_REF,
  TASK,
  makeProductFakePort,
  wrkfNoInstanceError,
} from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

/** Build the REAL flat `wrkf.task.inspect` shape for a PBC instance. */
function realFlatInspect(over: {
  status: string
  phase: string
  templateId?: string
  templateVersion?: string
  revision?: number
}): Record<string, unknown> {
  return {
    id: 'wfi_real_flat_t03072',
    taskUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    taskRef: `wrkq:${TASK}`,
    projectId: '6c774212-f2e4-47a5-a8bd-e91ab53df40a',
    templateId: over.templateId ?? 'pbc-progressive-refinement',
    templateVersion: over.templateVersion ?? '5',
    templateHash: 'sha256:deadbeef',
    status: over.status,
    phase: over.phase,
    revision: over.revision ?? 4,
    contextHash: 'sha256:ctx-real-flat',
    taskDocEtag: '11',
    taskDocHash: 'sha256:doc-real-flat',
    createdAt: '2026-06-01T10:00:00Z',
    updatedAt: '2026-06-08T12:00:00Z',
  }
}

describe('POST /v1/pbc/tasks/:taskId/start — duplicate-attach guard (RED)', () => {
  test('[RED] task.inspect is called BEFORE task.attach (inspect-first guard)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'attach-guard-001', intake: { title: 'test' } },
        })

        expect(response.status).toBe(200)

        const methods = wrkf._calls.map((c) => c.method)
        const inspectIdx = methods.indexOf('task.inspect')
        const attachIdx = methods.indexOf('task.attach')

        // inspect must occur (even if attach is never called)
        expect(inspectIdx).toBeGreaterThan(-1)

        // If attach is called, it must come AFTER inspect
        if (attachIdx >= 0) {
          expect(attachIdx).toBeGreaterThan(inspectIdx)
        }
      },
      { wrkf }
    )
  })

  test('[RED] task.attach NOT called when PBC instance already exists and is active', async () => {
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-pbc-existing',
          workflowRef: PBC_WORKFLOW_REF,
          state: { status: 'active', phase: 'behavior_note' },
          revision: 2,
          contextHash: 'sha256:ctx-bn-2',
        },
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'no-reattach-001', intake: { title: 'test' } },
        })

        expect(response.status).toBe(200)

        // task.attach must NOT be called — instance already exists
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] task.attach IS called when no instance exists', async () => {
    const wrkf = makeProductFakePort({
      // Default taskInspect returns no instance
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'fresh-attach-001', intake: { title: 'test' } },
        })

        expect(response.status).toBe(200)

        // task.attach MUST be called when no instance
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls.length).toBeGreaterThan(0)

        // Attach must use PBC workflow ref
        const attachParams = attachCalls[0]!.params as Record<string, unknown>
        expect(typeof attachParams['workflow']).toBe('string')
        expect(String(attachParams['workflow'])).toContain('pbc')
      },
      { wrkf }
    )
  })

  test('[RED] real wrkf THROWS WRKF_NOT_FOUND on inspect of a fresh task → start still attaches and returns 2xx', async () => {
    // Live ghoste2e bug (T-03050): the REAL wrkf binary throws WRKF_NOT_FOUND
    // ("workflow instance not found") when inspecting a task that was never
    // attached, rather than returning a no-instance object. start.ts must catch
    // that specific case, proceed to attach, and return the 2xx projection —
    // NOT surface a 404. The previous no-instance-object fake masked this.
    const wrkf = makeProductFakePort({
      taskInspect: async () => {
        throw wrkfNoInstanceError()
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'fresh-throws-not-found-001', intake: { title: 'test' } },
        })
        // Against the unfixed handler this is 404 WRKF_NOT_FOUND; must be 200.
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)

        // inspect threw → start must fall through to attach the PBC workflow.
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls.length).toBeGreaterThan(0)
        const attachParams = attachCalls[0]!.params as Record<string, unknown>
        expect(String(attachParams['workflow'])).toBe(PBC_WORKFLOW_REF)
      },
      { wrkf }
    )
  })

  test('[RED] inspect error that is NOT an instance-not-found case is rethrown (not swallowed)', async () => {
    // Only the specific "workflow instance not found" case may be swallowed.
    // A genuine wrkf failure (e.g. a transient WRKF_INTERNAL) must surface.
    const wrkf = makeProductFakePort({
      taskInspect: async () => {
        const error = new Error('wrkf exploded') as Error & { code: string }
        error.code = 'WRKF_INTERNAL'
        throw error
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'inspect-internal-error-001', intake: { title: 'test' } },
        })
        // Non-instance-not-found wrkf error must surface (500), not be swallowed.
        expect(response.status).toBe(500)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_INTERNAL')

        // attach must NOT be called when inspect fails for a non-NOT_FOUND reason.
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })
})

describe('POST /v1/pbc/tasks/:taskId/start — conflict scenarios (RED)', () => {
  test('[RED] active non-PBC instance → 409 conflict', async () => {
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-non-pbc',
          workflowRef: 'some-other-workflow@3',
          state: { status: 'active', phase: 'review' },
          revision: 5,
        },
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'non-pbc-conflict-001', intake: { title: 'test' } },
        })

        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/CONFLICT|INSTANCE_CONFLICT/)
      },
      { wrkf }
    )
  })

  test('[RED] closed PBC instance → 409 conflict (no restart semantics)', async () => {
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-pbc-closed',
          workflowRef: PBC_WORKFLOW_REF,
          state: { status: 'closed', phase: 'finalized' },
          revision: 9,
        },
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'closed-pbc-conflict-001', intake: { title: 'test' } },
        })

        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/CONFLICT|INSTANCE_CLOSED|CLOSED/)
      },
      { wrkf }
    )
  })
})

describe('POST /v1/pbc/tasks/:taskId/start — REAL flat inspect shape (T-03072)', () => {
  test('[RED] closed PBC instance in REAL flat shape → 409 INSTANCE_CLOSED', async () => {
    // status at TOP-LEVEL inspected.status (no instance wrapper), ref via templateId@templateVersion.
    const wrkf = makeProductFakePort({
      taskInspect: async () =>
        realFlatInspect({ status: 'closed', phase: 'finalized', revision: 4 }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'real-flat-closed-001', intake: { title: 'test' } },
        })
        // RED (pre-fix): guard reads inspected.instance (undefined) → attaches → 200.
        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/INSTANCE_CLOSED|CLOSED/)

        // Must NOT attach over a closed instance.
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] closed PBC instance attached at an OLDER version (@1) → 409 INSTANCE_CLOSED (not CONFLICT)', async () => {
    // Real live data: closed PBC instances exist with templateVersion '1' (e.g. T-01839),
    // while PBC_WORKFLOW_REF is pinned to @5. PBC detection must be by workflow NAME, so an
    // older-version closed PBC instance is INSTANCE_CLOSED, NOT misclassified as a conflict.
    const wrkf = makeProductFakePort({
      taskInspect: async () =>
        realFlatInspect({
          status: 'closed',
          phase: 'finalized',
          templateVersion: '1',
          revision: 6,
        }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'real-flat-closed-v1-001', intake: { title: 'test' } },
        })
        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/INSTANCE_CLOSED|CLOSED/)
      },
      { wrkf }
    )
  })

  test('[RED] active non-PBC instance in REAL flat shape → 409 INSTANCE_CONFLICT', async () => {
    const wrkf = makeProductFakePort({
      taskInspect: async () =>
        realFlatInspect({
          status: 'active',
          phase: 'review',
          templateId: 'some-other-workflow',
          templateVersion: '3',
          revision: 2,
        }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'real-flat-conflict-001', intake: { title: 'test' } },
        })
        // RED (pre-fix): guard misses the flat instance → attaches a 2nd workflow → 200.
        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/CONFLICT|INSTANCE_CONFLICT/)

        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] active PBC instance in REAL flat shape → reuse (no re-attach, 200)', async () => {
    // An existing ACTIVE PBC instance must be reused, never re-attached.
    const wrkf = makeProductFakePort({
      taskInspect: async () =>
        realFlatInspect({ status: 'active', phase: 'behavior_note', revision: 2 }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'real-flat-reuse-001', intake: { title: 'test' } },
        })
        expect(response.status).toBe(200)

        // Existing active PBC instance → must NOT attach again.
        const attachCalls = wrkf._calls.filter((c) => c.method === 'task.attach')
        expect(attachCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })
})
