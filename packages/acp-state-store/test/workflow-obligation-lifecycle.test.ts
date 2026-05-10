import { describe, expect, test } from 'bun:test'

import type { WorkflowKernelSnapshot } from 'acp-core'

import { openAcpStateStore } from '../src/index.js'

const lifecycleSnapshot = {
  definitions: [],
  tasks: [
    {
      taskId: 'task-obligation-serde',
      projectId: 'demo',
      workflow: { id: 'serde', version: 1, hash: 'sha256:serde' },
      state: { status: 'active', phase: 'review' },
      version: 2,
      goal: 'Persist obligation lifecycle metadata',
      roleBindings: {},
      createdAt: '2026-05-09T12:00:00.000Z',
      updatedAt: '2026-05-09T12:00:00.000Z',
    },
  ],
  evidence: [],
  obligations: [
    {
      obligationId: 'obl_waived',
      taskId: 'task-obligation-serde',
      kind: 'evidence_override',
      ownerRole: 'implementer',
      summary: 'waived obligation',
      blocking: false,
      status: 'waived',
      createdAt: '2026-05-09T12:00:00.000Z',
      updatedAt: '2026-05-09T12:00:00.000Z',
      waivedAt: '2026-05-09T12:00:00.000Z',
      waiverReason: 'accepted evidence gap',
      waiverEvidenceRefs: ['artifact://waiver-note'],
    },
    {
      obligationId: 'obl_cancelled',
      taskId: 'task-obligation-serde',
      kind: 'obsolete_path',
      summary: 'cancelled obligation',
      blocking: false,
      status: 'cancelled',
      createdAt: '2026-05-09T12:00:00.000Z',
      updatedAt: '2026-05-09T12:00:00.000Z',
      cancelledAt: '2026-05-09T12:00:00.000Z',
      cancelReason: 'superseded by supervisor',
    },
    {
      obligationId: 'obl_expired',
      taskId: 'task-obligation-serde',
      kind: 'timer_later',
      summary: 'reserved expired status',
      blocking: false,
      status: 'expired',
      createdAt: '2026-05-09T12:00:00.000Z',
      updatedAt: '2026-05-09T12:00:00.000Z',
    },
  ],
  effects: [],
  events: [],
  supervisorRuns: [],
  participantRuns: [],
  anomalies: [],
  patchProposals: [],
  idempotency: [],
  contextHashes: [],
  sequence: 3,
} satisfies WorkflowKernelSnapshot

describe('workflow obligation lifecycle snapshot serde', () => {
  test('persists waived, cancelled, and reserved expired obligation records', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })

    try {
      store.workflowRuntime.saveSnapshot(lifecycleSnapshot)
      const reloaded = store.workflowRuntime.loadSnapshot()

      expect(reloaded.obligations).toContainEqual(
        expect.objectContaining({
          obligationId: 'obl_waived',
          status: 'waived',
          waivedAt: '2026-05-09T12:00:00.000Z',
          waiverReason: 'accepted evidence gap',
          waiverEvidenceRefs: ['artifact://waiver-note'],
        })
      )
      expect(reloaded.obligations).toContainEqual(
        expect.objectContaining({
          obligationId: 'obl_cancelled',
          status: 'cancelled',
          cancelledAt: '2026-05-09T12:00:00.000Z',
          cancelReason: 'superseded by supervisor',
        })
      )
      expect(reloaded.obligations).toContainEqual(
        expect.objectContaining({
          obligationId: 'obl_expired',
          status: 'expired',
        })
      )
    } finally {
      store.close()
    }
  })
})
