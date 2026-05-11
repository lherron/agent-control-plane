import { describe, expect, test } from 'bun:test'

import {
  type LearningArtifactBase,
  type PatchBundle,
  type TraceUseLabel,
  basicWorkflowV1,
  createInMemoryWorkflowKernel,
  materializeWorkflowTrace,
  reviewTraceLabel,
  runDeterministicWorkflowReplay,
  transitionLearningArtifactLifecycle,
  validatePromotionReadiness,
} from '../index.js'

const learner = { kind: 'agent' as const, id: 'learner' }
const reviewer = { kind: 'agent' as const, id: 'reviewer' }
const externalAuthority = { kind: 'human' as const, id: 'ops-lead' }

function buildSnapshot() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-11T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(basicWorkflowV1)
  const created = kernel.createTask({
    taskId: 'trace-task',
    projectId: 'agent-spaces',
    workflow: { id: 'basic', version: 1 },
    goal: 'materialize learning trace',
    roleBindings: { owner: learner },
    idempotencyKey: 'trace:create',
  })
  expect(created.ok).toBe(true)
  const started = kernel.applyTransition({
    taskId: 'trace-task',
    transitionId: 'start',
    actor: learner,
    role: 'owner',
    expectedTaskVersion: 0,
    idempotencyKey: 'trace:start',
  })
  expect(started.ok).toBe(true)
  const rejected = kernel.applyTransition({
    taskId: 'trace-task',
    transitionId: 'close_success',
    actor: learner,
    role: 'owner',
    expectedTaskVersion: 1,
    idempotencyKey: 'trace:close-rejected',
  })
  expect(rejected.ok).toBe(false)
  const mapped = kernel.recordWorkflowHrcRunMap({
    workflowTaskId: 'trace-task',
    hrcRunId: 'hrc-trace-run',
    source: 'launch',
    actor: learner,
    idempotencyKey: 'trace:map',
  })
  expect(mapped.ok).toBe(true)
  return kernel.exportSnapshot()
}

describe('learning tool helpers', () => {
  test('materializes correlated workflow traces and deterministic replay reports', () => {
    const snapshot = buildSnapshot()
    const { trace, ingestReport } = materializeWorkflowTrace({
      snapshot,
      workflowTaskId: 'trace-task',
      hrcEventStats: { 'hrc-trace-run': { toolCalls: 2, toolErrors: 1 } },
    })

    expect(ingestReport.correlationState).toBe('fully_correlated')
    expect(trace.metrics.transitionsAccepted).toBe(1)
    expect(trace.metrics.transitionsRejected).toBe(1)
    expect(trace.metrics.hrcToolCalls).toBe(2)
    expect(trace.hrcRanges[0]).toMatchObject({ hrcRunId: 'hrc-trace-run' })

    const replay = runDeterministicWorkflowReplay({ snapshot, workflowTaskId: 'trace-task' })
    expect(replay.results).toEqual([
      expect.objectContaining({ traceId: trace.traceId, outcome: 'passed', failedProperties: [] }),
    ])
  })

  test('trace label review enforces learner/reviewer separation for eval-use labels', () => {
    const label: TraceUseLabel = {
      traceId: 'trace-1',
      use: 'usable_for_regression',
      source: 'learner_proposed',
      reason: 'candidate',
      sourceEventIds: ['wevt_1'],
      createdAt: '2026-05-11T12:00:00.000Z',
    }

    expect(() =>
      reviewTraceLabel({
        label,
        proposer: learner,
        reviewer: learner,
        reason: 'self-review is not trusted',
      })
    ).toThrow('reviewer separation')

    expect(
      reviewTraceLabel({
        label,
        proposer: learner,
        reviewer,
        reason: 'independently reviewed',
      })
    ).toMatchObject({ reviewedBy: reviewer, reason: 'independently reviewed' })
  })

  test('low-authority lifecycle and high-authority promotion gates are enforced', () => {
    const artifact: LearningArtifactBase = {
      artifactId: 'playbook-1',
      artifactKind: 'workflow_playbook',
      authorityTier: 2,
      lifecycle: 'draft',
      origin: 'learner_proposed',
      sourceTraceIds: ['trace-1'],
      sourceEventIds: ['wevt_1'],
      createdBy: learner,
      createdAt: '2026-05-11T12:00:00.000Z',
      updatedAt: '2026-05-11T12:00:00.000Z',
    }

    expect(
      transitionLearningArtifactLifecycle(artifact, 'active', {
        actor: reviewer,
        reason: 'reviewed',
        now: '2026-05-11T12:01:00.000Z',
      })
    ).toMatchObject({ lifecycle: 'active', updatedAt: '2026-05-11T12:01:00.000Z' })
    expect(() =>
      transitionLearningArtifactLifecycle({ ...artifact, lifecycle: 'archived' }, 'active', {
        actor: reviewer,
        reason: 'cannot revive archive directly',
      })
    ).toThrow('invalid learning artifact lifecycle transition')

    const patchBundle: PatchBundle = {
      patchBundleId: 'patch-1',
      title: 'Require fresh QA evidence',
      hypothesis: 'Stale evidence should reject',
      sourceTraceIds: ['trace-1'],
      sourceEventIds: ['wevt_1'],
      facets: { transitionRequirementChanges: {} },
      risk: {
        changesAuthority: false,
        weakensRequirement: true,
        expandsCapability: false,
        changesEvaluator: false,
        changesTaskTaxonomy: false,
        suppressesOrReclassifiesAnomalies: false,
      },
      evalPlan: {
        replayTraceIds: ['trace-1'],
        regressionSuiteIds: ['suite-regression'],
        counterfactualSuiteIds: ['suite-negative'],
        requiredInvariants: ['stale_context_rejected'],
      },
      rollbackPlan: 'restore previous workflow definition',
      author: learner,
      createdAt: '2026-05-11T12:00:00.000Z',
    }

    expect(
      validatePromotionReadiness({
        patchBundle,
        replayReportIds: [],
        evalReportIds: ['eval-1'],
        promotionReviewer: learner,
      }).unmetRequirements
    ).toEqual([
      'promotion_reviewer_must_differ_from_patch_author',
      'replay_report_required',
      'external_authority_required',
    ])
    expect(
      validatePromotionReadiness({
        patchBundle,
        replayReportIds: ['replay-1'],
        evalReportIds: ['eval-1'],
        promotionReviewer: reviewer,
        externalAuthority,
      })
    ).toMatchObject({ unmetRequirements: [], recommendation: 'stage' })
  })
})
