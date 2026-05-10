import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type WorkflowDefinition,
  createInMemoryWorkflowKernel,
} from '../../../packages/acp-core/src/workflow/index.js'

const owner: ActorRef = { kind: 'agent', id: 'cody' }
const supervisor: ActorRef = { kind: 'agent', id: 'rex' }

const evidenceSelectionWorkflow = {
  id: 'evidence_selection',
  version: 1,
  kind: 'generic',
  initial: { status: 'active', phase: 'collect' },
  phases: { collect: {} },
  outcomes: { success: {} },
  roles: { owner: { binding: 'required' } },
  evidenceKinds: {
    completion_note: { requiredFields: ['summary'] },
  },
  transitions: {
    close_success: {
      id: 'close_success',
      from: { status: 'active', phase: 'collect' },
      to: { status: 'closed', outcome: 'success' },
      by: ['owner'],
      requires: [{ type: 'evidence', kinds: ['completion_note'], mode: 'all' }],
    },
  },
} satisfies WorkflowDefinition

function createKernel() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-09T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(evidenceSelectionWorkflow)
  const created = kernel.createTask({
    taskId: 'task-evidence-provenance',
    projectId: 'agent-spaces',
    workflow: { id: 'evidence_selection', version: 1 },
    goal: 'prove evidence provenance',
    roleBindings: { owner },
    supervisor: {
      actor: supervisor,
      autonomy: 'managed',
      capabilities: { attachEvidence: true },
    },
    idempotencyKey: 'task:create:evidence-provenance',
  })
  if (!created.ok) {
    throw new Error(created.error.message)
  }
  return { kernel, task: created.task }
}

describe('ACP workflow evidence provenance', () => {
  test('EvidenceRecord captures the actor, role, and run that attached inline transition evidence', () => {
    const { kernel, task } = createKernel()

    const result = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'close_success',
      actor: owner,
      role: 'owner',
      runId: 'run-owner-1',
      expectedTaskVersion: 0,
      inlineEvidence: [
        {
          kind: 'completion_note',
          ref: 'artifact://done',
          summary: 'Owner attached completion evidence',
        },
      ],
      idempotencyKey: 'transition:close-with-inline-evidence',
    })

    expect(result.ok).toBe(true)
    const [record] = kernel.listEvidence(task.taskId)
    expect(record).toMatchObject({
      kind: 'completion_note',
      ref: 'artifact://done',
      actor: owner,
      role: 'owner',
      runId: 'run-owner-1',
    })
    expect(record).not.toHaveProperty('supervisorRunId')
    expect(record).not.toHaveProperty('participantRunId')

    const [attached] = kernel
      .listEvents(task.taskId)
      .filter((event) => event.type === 'evidence.attached')
    expect(attached).toMatchObject({
      actor: owner,
      runId: 'run-owner-1',
      payload: {
        actor: owner,
        role: 'owner',
        runId: 'run-owner-1',
      },
    })
  })

  test('transition.applied records only the caller-selected evidenceRefs', () => {
    const { kernel, task } = createKernel()
    const snapshot = kernel.exportSnapshot()
    const selectedEvidenceId = 'evd_selected_completion'
    const ignoredEvidenceId = 'evd_ignored_completion'
    const replay = createInMemoryWorkflowKernel({
      now: '2026-05-09T12:01:00.000Z',
      snapshot: {
        ...snapshot,
        evidence: [
          {
            evidenceId: selectedEvidenceId,
            taskId: task.taskId,
            kind: 'completion_note',
            ref: 'artifact://selected',
            summary: 'This exact note should be cited',
            actor: owner,
            role: 'owner',
            runId: 'run-owner-1',
            createdAt: '2026-05-09T12:00:01.000Z',
          } as never,
          {
            evidenceId: ignoredEvidenceId,
            taskId: task.taskId,
            kind: 'completion_note',
            ref: 'artifact://ignored',
            summary: 'Same kind, not selected by this transition',
            actor: owner,
            role: 'owner',
            runId: 'run-owner-2',
            createdAt: '2026-05-09T12:00:02.000Z',
          } as never,
        ],
      },
    })

    const result = replay.applyTransition({
      taskId: task.taskId,
      transitionId: 'close_success',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      evidenceRefs: [selectedEvidenceId],
      idempotencyKey: 'transition:close-with-selected-evidence',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event.payload).toMatchObject({
        transitionId: 'close_success',
        evidenceRefs: [selectedEvidenceId],
      })
      expect(result.event.payload).not.toMatchObject({
        evidenceRefs: expect.arrayContaining([ignoredEvidenceId]),
      })
    }
  })
})
