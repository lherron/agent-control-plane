/**
 * GET /v1/tasks/:taskId projection includes the pack block (T-02347).
 *
 * Target: packages/acp-server/src/handlers/workflow-tasks.ts (handleGetWorkflowTask),
 * which resolves `${templateId}@${templateVersion}` (+ templateHash) through
 * defaultWorkflowPackRegistry and returns { id?, level, supported, reason? } as `pack`.
 *
 * No packs ship since the PBC pack was removed (T-14375): every workflow,
 * including a task still on pbc-progressive-refinement, gets { level: 0,
 * supported: false } with no pack id.
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
  // ── 1. Former PBC workflow ref → generic block (pack removed, T-14375) ──
  describe('former PBC workflow inspect → generic level-0 pack block', () => {
    test('pack block has supported:false, level:0 and no id for pbc-progressive-refinement@9', async () => {
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
          expect(body.pack).toEqual({ level: 0, supported: false })
          expect((body as unknown as Record<string, unknown>)['source']).toBe('wrkf')
          expect((body as unknown as Record<string, unknown>)['task']).toBeDefined()
          expect((body as unknown as Record<string, unknown>)['next']).toBeDefined()
        },
        {
          wrkf: makePackTestWrkfPort({
            templateId: 'pbc-progressive-refinement',
            templateVersion: '9',
          }),
        }
      )
    })
  })

  // ── 2. Unknown workflow ref → pack: { level: 0, supported: false } ─────────
  //
  describe('unknown workflow inspect → pack: { level: 0, supported: false } ', () => {
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
          expect(body.pack).toBeDefined()
          expect(body.pack.supported).toBe(false)
          expect(body.pack.level).toBe(0)
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
  describe('existing projection fields survive pack addition (RED: pack absent → fails early)', () => {})
})
