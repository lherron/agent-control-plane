/**
 * RED TESTS — Phase 2a: GET /v1/tasks/:taskId projection includes pack block (T-02347)
 *
 * All tests fail NOW because the handler does not return a `pack` field yet.
 * The `pack` assertion (expect(body.pack).toBeDefined()) will fail for every test below.
 *
 * Target: packages/acp-server/src/handlers/workflow-tasks.ts (handleGetWorkflowTask)
 *
 * What the impl agent must change to make these tests green:
 *
 *   1. Create/import a global WorkflowPackRegistry (wired in create-acp-server or an init
 *      module) with pbcManifest registered. The registry must be PBC-free itself; the
 *      pbcManifest registration is the only place PBC strings appear in the wiring.
 *
 *   2. In handleGetWorkflowTask, after projectFlatWrkfInspect builds the task projection:
 *        const workflowId  = optionalString(inspectedRecord, 'templateId') ?? ''
 *        const version     = String(optionalWorkflowVersion(inspectedRecord))
 *        const templateHash = optionalString(inspectedRecord, 'templateHash')
 *        const workflowRef  = `${workflowId}@${version}`
 *        const { pack: resolvedPack, support } = packRegistry.resolve({ workflowRef, templateHash })
 *        const packBlock = {
 *          ...(resolvedPack?.id !== undefined ? { id: resolvedPack.id } : {}),
 *          level: support.level,
 *          supported: support.supported,
 *          ...(support.reason !== undefined ? { reason: support.reason } : {}),
 *        }
 *
 *   3. Include packBlock in the json() response:
 *        return json({ source: 'wrkf', task, instance, pack: packBlock, next, ... })
 *
 *   4. Unknown workflow (no registered pack claims it) → { level: 0, supported: false }
 *      PBC workflow (pbcManifest claims it)            → { id: 'pbc', level: 3, supported: true }
 *
 * Grep boundary (must stay clean after impl):
 *   rg -i 'pbc|progressive.refinement|pressure|clarification|patch_decision' \
 *      packages/acp-server/src/wrkf/runtime/
 *   → must be EMPTY
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_ID = 'T-PACKTEST01'

// ── Fake port factory ─────────────────────────────────────────────────────────
//
// Produces a minimal fake AcpWrkfWorkflowPort that returns the real flat inspect
// shape (no task/instance wrapper — see wrkf-real-inspect-shape.test.ts for rationale).
// The templateId/templateVersion/templateHash fields drive pack registry resolution.

type FakeInspectFields = {
  templateId: string
  templateVersion: string
  templateHash?: string | undefined
}

function makePackTestWrkfPort(fields: FakeInspectFields): AcpWrkfWorkflowPort {
  const notCalled = (name: string) => (): never => {
    throw new Error(`fake AcpWrkfWorkflowPort: ${name} must not be called in this test`)
  }
  const flatInspect: Record<string, unknown> = {
    id: `wfi_${TASK_ID.toLowerCase()}`,
    taskRef: `wrkq:${TASK_ID}`,
    projectId: '00000000-0000-0000-0000-000000000001',
    templateId: fields.templateId,
    templateVersion: fields.templateVersion,
    ...(fields.templateHash !== undefined ? { templateHash: fields.templateHash } : {}),
    status: 'active',
    phase: 'doing',
    revision: 1,
    contextHash: 'sha256:aabbcc112233',
    createdAt: '2026-06-08T00:00:00Z',
    updatedAt: '2026-06-08T00:00:00Z',
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
      inspect: async (_params) => flatInspect,
      timeline: async (_params) => [],
      refresh: notCalled('task.refresh'),
      syncMeta: notCalled('task.syncMeta'),
    },
    next: async (_params) => ({
      instance: {
        id: `wfi_${TASK_ID.toLowerCase()}`,
        taskRef: `wrkq:${TASK_ID}`,
        template: {
          id: fields.templateId,
          version: fields.templateVersion,
          ...(fields.templateHash !== undefined ? { hash: fields.templateHash } : {}),
        },
        state: { status: 'active', phase: 'doing' },
        revision: 1,
        contextHash: 'sha256:aabbcc112233',
        stale: false,
      },
      actions: [],
      blockedTransitions: [],
      openObligations: [],
      pendingEffects: [],
    }),
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

// ── Test suites ───────────────────────────────────────────────────────────────

describe('P2a: GET /v1/tasks/:taskId — projection includes pack block', () => {
  // ── 1. PBC workflow ref → pack: { id: 'pbc', level: 3, supported: true } ───
  //
  // RED because: handler does not include a `pack` field in its json() response yet.
  // GREEN once: handler calls packRegistry.resolve({ workflowRef, templateHash }) and
  //             includes the result as `pack` in the response JSON.
  //
  // The inspect returns templateId='pbc-progressive-refinement', templateVersion='5'
  // (no hash supplied here — hash-free case; pbcManifest returns supported:true).
  //
  describe('PBC workflow inspect → pack resolved as supported level-3 (RED: pack field absent)', () => {
    test('GET returns 200 with pack field present when wrkf reports pbc-progressive-refinement@5', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{ source: string; pack: unknown }>(response)
          // RED: body.pack is undefined — handler does not return a pack field yet
          expect(body.pack).toBeDefined()
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'pbc-progressive-refinement',
            templateVersion: '5',
          }),
        }
      )
    })

    test('pack block has supported:true and level:3 for pbc-progressive-refinement@5', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            pack: { id?: string; level: number; supported: boolean; reason?: string }
          }>(response)
          // RED: body.pack is undefined
          expect(body.pack).toBeDefined()
          expect(body.pack.supported).toBe(true)
          expect(body.pack.level).toBe(3)
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'pbc-progressive-refinement',
            templateVersion: '5',
          }),
        }
      )
    })

    test('pack block id is "pbc" for pbc-progressive-refinement@5', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            pack: { id?: string; level: number; supported: boolean }
          }>(response)
          // RED: body.pack is undefined
          expect(body.pack?.id).toBe('pbc')
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'pbc-progressive-refinement',
            templateVersion: '5',
          }),
        }
      )
    })
  })

  // ── 2. Unknown workflow ref → pack: { level: 0, supported: false } ─────────
  //
  // RED because: handler does not include a `pack` field in its json() response yet.
  // GREEN once: handler includes pack from registry; registry returns level-0/unsupported
  //             for any workflowRef not claimed by a registered pack.
  //
  describe('unknown workflow inspect → pack: { level: 0, supported: false } (RED: pack field absent)', () => {
    test('GET returns 200 with pack field present when wrkf reports an unknown workflow', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{ pack: unknown }>(response)
          // RED: body.pack is undefined
          expect(body.pack).toBeDefined()
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'agent-tasker-feature-request',
            templateVersion: '3',
          }),
        }
      )
    })

    test('pack block has supported:false and level:0 for an unknown workflow ref', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            pack: { id?: string; level: number; supported: boolean; reason?: string }
          }>(response)
          // RED: body.pack is undefined
          expect(body.pack).toBeDefined()
          expect(body.pack.supported).toBe(false)
          expect(body.pack.level).toBe(0)
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'agent-tasker-feature-request',
            templateVersion: '3',
          }),
        }
      )
    })

    test('pack block for unknown workflow has no id field', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            pack: { id?: string; level: number; supported: boolean }
          }>(response)
          // RED: body.pack is undefined
          // GREEN: pack exists but has no id (no pack claimed this workflow)
          expect(body.pack).toBeDefined()
          expect(body.pack.id).toBeUndefined()
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'agent-tasker-feature-request',
            templateVersion: '3',
          }),
        }
      )
    })
  })

  // ── 3. Existing response fields are not disrupted by adding pack ─────────────
  //
  // RED because: handler does not include a `pack` field yet (body.pack is undefined).
  // GREEN once: pack field is added; source/task/instance/next etc. remain intact.
  //
  describe('existing projection fields survive pack addition (RED: pack absent → fails early)', () => {
    test('response still has source:"wrkf", task, next after pack field is added', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            source: string
            task: unknown
            next: unknown
            pack: unknown
          }>(response)
          // Pack must be present (RED now)
          expect(body.pack).toBeDefined()
          // Pre-existing fields must remain
          expect(body.source).toBe('wrkf')
          expect(body.task).toBeDefined()
          expect(body.next).toBeDefined()
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'pbc-progressive-refinement',
            templateVersion: '5',
          }),
        }
      )
    })
  })
})
