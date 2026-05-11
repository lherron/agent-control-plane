import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  createInMemoryWorkflowKernel,
  learningPatchPromotionWorkflowV1,
  learningTraceLabelingWorkflowV1,
} from '../index.js'

const learner: ActorRef = { kind: 'agent', id: 'learner' }
const promoter: ActorRef = { kind: 'human', id: 'ops-lead' }

describe('ACP learning workflow presets', () => {
  test('trace labels require reviewer separation before trusted acceptance', () => {
    const kernel = createInMemoryWorkflowKernel({ now: '2026-05-11T12:00:00.000Z' })
    kernel.publishWorkflowDefinition(learningTraceLabelingWorkflowV1)
    const created = kernel.createTask({
      taskId: 'learning-label-1',
      projectId: 'agent-spaces',
      workflow: { id: 'learning_trace_labeling', version: 1 },
      goal: 'review trace label provenance',
      roleBindings: {
        learning_supervisor: learner,
        trace_reviewer: learner,
        label_reviewer: learner,
      },
      idempotencyKey: 'learning-label:create',
    })
    expect(created.ok).toBe(true)

    const proposed = kernel.applyTransition({
      taskId: 'learning-label-1',
      transitionId: 'propose_label',
      actor: learner,
      role: 'trace_reviewer',
      expectedTaskVersion: 0,
      inlineEvidence: [{ kind: 'trace_label', ref: 'artifact://label' }],
      idempotencyKey: 'learning-label:propose',
    })
    expect(proposed.ok).toBe(true)

    const selfReview = kernel.applyTransition({
      taskId: 'learning-label-1',
      transitionId: 'review_label',
      actor: learner,
      role: 'label_reviewer',
      expectedTaskVersion: 1,
      inlineEvidence: [{ kind: 'label_review', ref: 'artifact://self-review' }],
      idempotencyKey: 'learning-label:self-review',
    })
    expect(selfReview.ok).toBe(false)

    const events = kernel.listEvents('learning-label-1')
    expect(events.at(-1)).toMatchObject({
      type: 'transition.rejected',
      result: 'rejected',
      rejectionCode: 'sod_violation',
    })
  })

  test('high-authority promotion requires external authority and cannot be self-promoted', () => {
    const kernel = createInMemoryWorkflowKernel({ now: '2026-05-11T12:00:00.000Z' })
    kernel.publishWorkflowDefinition(learningPatchPromotionWorkflowV1)
    const created = kernel.createTask({
      taskId: 'learning-promotion-1',
      projectId: 'agent-spaces',
      workflow: { id: 'learning_patch_promotion', version: 1 },
      goal: 'promote policy patch with separation of duty',
      roleBindings: {
        learning_supervisor: learner,
        patch_author: learner,
        promotion_reviewer: learner,
        external_authority: promoter,
      },
      idempotencyKey: 'learning-promotion:create',
    })
    expect(created.ok).toBe(true)

    const selfReview = kernel.applyTransition({
      taskId: 'learning-promotion-1',
      transitionId: 'authority_review',
      actor: learner,
      role: 'promotion_reviewer',
      expectedTaskVersion: 0,
      inlineEvidence: [
        { kind: 'patch_bundle', ref: 'artifact://patch' },
        { kind: 'replay_report', ref: 'artifact://replay' },
        { kind: 'eval_report', ref: 'artifact://eval' },
      ],
      idempotencyKey: 'learning-promotion:self-review',
    })
    expect(selfReview.ok).toBe(false)

    const externalPromote = kernel.applyTransition({
      taskId: 'learning-promotion-1',
      transitionId: 'promote',
      actor: promoter,
      role: 'external_authority',
      expectedTaskVersion: 0,
      inlineEvidence: [
        { kind: 'promotion_readiness_report', ref: 'artifact://ready' },
        { kind: 'external_authority_approval', ref: 'artifact://approval' },
      ],
      idempotencyKey: 'learning-promotion:external-too-early',
    })
    expect(externalPromote.ok).toBe(false)
    expect(kernel.listEvents('learning-promotion-1').map((event) => event.result)).toContain(
      'rejected'
    )
  })
})
