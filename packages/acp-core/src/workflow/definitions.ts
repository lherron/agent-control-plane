import type { Preset, TransitionPolicyRule } from '../models/preset.js'
import { codeDefectFastlaneV1 } from '../presets/code_defect_fastlane.v1.js'
import { codeFeatureTddV1 } from '../presets/code_feature_tdd.v1.js'
import type { Requirement, RoleSpec, WorkflowDefinition } from './index.js'

function transitionIdFor(rule: TransitionPolicyRule): string {
  if (rule.toPhase === 'completed') {
    return 'close_success'
  }
  return `${rule.fromPhase}_to_${rule.toPhase}`
}

function requirementsFor(rule: TransitionPolicyRule, role: string): Requirement[] {
  const requirements: Requirement[] = []
  if (rule.requiredEvidenceKinds.length > 0) {
    requirements.push({ type: 'evidence', kinds: [...rule.requiredEvidenceKinds], mode: 'all' })
  }
  if (rule.disallowSameAgentAsRoles.length > 0) {
    requirements.push({
      type: 'sod',
      actingRole: role,
      notSameAs: [...rule.disallowSameAgentAsRoles],
    })
  }
  return requirements
}

function presetToWorkflowDefinition(preset: Preset): WorkflowDefinition {
  const firstPhase = preset.phaseGraph[0]
  if (firstPhase === undefined) {
    throw new Error(`Preset ${preset.presetId}@${preset.version} has no initial phase`)
  }

  const roles: Record<string, RoleSpec> = Object.fromEntries(
    preset.defaultRoles.map((role) => [
      role,
      { binding: role === 'owner' ? 'optional' : 'required' },
    ])
  )
  const phases = Object.fromEntries(preset.phaseGraph.map((phase) => [phase, {}]))
  const evidenceKinds = Object.fromEntries(
    [
      ...new Set(
        preset.transitionPolicy.flatMap((rule) => [
          ...rule.requiredEvidenceKinds,
          ...(rule.waiverKinds ?? []),
        ])
      ),
    ].map((kind) => [kind, { requiredFields: ['ref'] }])
  )
  const transitions: WorkflowDefinition['transitions'] = {}

  for (const rule of preset.transitionPolicy) {
    const id = transitionIdFor(rule)
    const role = rule.allowedRoles[0] ?? 'owner'
    transitions[id] = {
      id,
      from: { status: rule.fromPhase === firstPhase ? 'open' : 'active', phase: rule.fromPhase },
      to:
        rule.toPhase === 'completed'
          ? { status: 'closed', outcome: 'success' }
          : { status: 'active', phase: rule.toPhase },
      by: [...rule.allowedRoles],
      requires: requirementsFor(rule, role),
    }
  }

  return {
    id: preset.presetId,
    version: preset.version,
    kind: preset.kind,
    initial: { status: 'open', phase: firstPhase },
    phases,
    outcomes: {
      success: {},
      cancelled: {},
      failed: {},
    },
    roles,
    evidenceKinds,
    transitions,
  }
}

export const basicWorkflowV1 = {
  id: 'basic',
  version: 1,
  kind: 'generic',
  initial: { status: 'open', phase: 'todo' },
  phases: {
    todo: {},
    doing: {},
  },
  outcomes: {
    success: {},
    cancelled: {},
    failed: {},
  },
  roles: {
    owner: { binding: 'autoBindOnFirstRun' },
  },
  evidenceKinds: {
    completion_note: { requiredFields: ['summary'] },
  },
  transitions: {
    start: {
      id: 'start',
      from: { status: 'open', phase: 'todo' },
      to: { status: 'active', phase: 'doing' },
      by: ['owner'],
    },
    close_success: {
      id: 'close_success',
      from: { status: 'active', phase: 'doing' },
      to: { status: 'closed', outcome: 'success' },
      by: ['owner'],
      requires: [{ type: 'evidence', kinds: ['completion_note'], mode: 'all' }],
    },
    cancel: {
      id: 'cancel',
      from: { status: 'active' },
      to: { status: 'closed', outcome: 'cancelled' },
      by: ['owner'],
      supervisorBypass: true,
    },
  },
} satisfies WorkflowDefinition

const codeDefectFastlaneBase = presetToWorkflowDefinition(codeDefectFastlaneV1)
const codeDefectFastlaneRedToGreen = codeDefectFastlaneBase.transitions['red_to_green']
if (codeDefectFastlaneRedToGreen === undefined) {
  throw new Error('code_defect_fastlane workflow conversion missed red_to_green')
}

export const codeDefectFastlaneWorkflowV1 = {
  ...codeDefectFastlaneBase,
  roles: {
    triager: { binding: 'optional' },
    implementer: { binding: 'required' },
    tester: { binding: 'optional', mustDifferFrom: ['implementer'] },
    owner: { binding: 'optional' },
  },
  obligationKinds: {
    missing_evidence: {
      blockingDefault: true,
      ownerRoles: ['implementer', 'tester'],
      allowedSatisfactionEvidence: ['tdd_green_bundle', 'qa_bundle'],
    },
  },
  transitions: {
    ...codeDefectFastlaneBase.transitions,
    red_to_green: {
      ...codeDefectFastlaneRedToGreen,
      effects: [
        {
          type: 'declare_handoff',
          toRole: 'tester',
          kind: 'review',
          when: [
            { type: 'risk_at_least', level: 'medium' },
            { type: 'role_bound', role: 'tester' },
          ],
        },
        {
          type: 'wake_role_session',
          role: 'tester',
          when: [
            { type: 'risk_at_least', level: 'medium' },
            { type: 'role_bound', role: 'tester' },
          ],
        },
      ],
    },
  },
} satisfies WorkflowDefinition

export const codeFeatureTddWorkflowV1 = presetToWorkflowDefinition(codeFeatureTddV1)

const learningRoles = {
  learning_supervisor: { binding: 'required' },
  trace_reviewer: { binding: 'optional' },
  label_reviewer: { binding: 'optional' },
  playbook_author: { binding: 'optional' },
  playbook_reviewer: { binding: 'optional' },
  curator: { binding: 'optional' },
  patch_author: { binding: 'optional' },
  evaluator_runner: { binding: 'optional' },
  evaluation_steward: { binding: 'optional' },
  promotion_reviewer: { binding: 'optional' },
  learning_auditor: { binding: 'optional' },
  correlation_steward: { binding: 'optional' },
  external_authority: { binding: 'optional' },
} satisfies Record<string, RoleSpec>

const commonLearningEvidence = {
  learning_trigger: { requiredFields: ['ref'] },
  trace_ingest_report: { requiredFields: ['ref'] },
  trace_assessment: { requiredFields: ['ref'] },
  failure_classification: { requiredFields: ['ref'] },
  no_op_report: { requiredFields: ['ref'] },
  trace_label: { requiredFields: ['ref'] },
  label_review: { requiredFields: ['ref'] },
  trace_note: { requiredFields: ['ref'] },
  playbook_draft: { requiredFields: ['ref'] },
  playbook_review: { requiredFields: ['ref'] },
  curation_report: { requiredFields: ['ref'] },
  patch_bundle: { requiredFields: ['ref'] },
  risk_review: { requiredFields: ['ref'] },
  replay_report: { requiredFields: ['ref'] },
  eval_report: { requiredFields: ['ref'] },
  promotion_readiness_report: { requiredFields: ['ref'] },
  rollback_plan: { requiredFields: ['ref'] },
  audit_report: { requiredFields: ['ref'] },
  meta_eval_report: { requiredFields: ['ref'] },
  external_authority_approval: { requiredFields: ['ref'] },
}

export const learningTraceTriageWorkflowV1 = {
  id: 'learning_trace_triage',
  version: 1,
  kind: 'learning-task/trace-triage',
  initial: { status: 'open', phase: 'observed' },
  phases: { observed: {}, trace_materialized: {}, reviewed: {}, classified: {} },
  outcomes: {
    closed_noop: {},
    playbook_candidate: {},
    policy_candidate: {},
    quarantined: {},
  },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    materialize_trace: {
      id: 'materialize_trace',
      from: { status: 'open', phase: 'observed' },
      to: { status: 'active', phase: 'trace_materialized' },
      by: ['learning_supervisor', 'trace_reviewer', 'correlation_steward'],
      requires: [{ type: 'evidence', kinds: ['learning_trigger', 'trace_ingest_report'] }],
    },
    review_trace: {
      id: 'review_trace',
      from: { status: 'active', phase: 'trace_materialized' },
      to: { status: 'active', phase: 'reviewed' },
      by: ['trace_reviewer'],
      requires: [{ type: 'evidence', kinds: ['trace_assessment'] }],
    },
    classify_trace: {
      id: 'classify_trace',
      from: { status: 'active', phase: 'reviewed' },
      to: { status: 'active', phase: 'classified' },
      by: ['learning_supervisor'],
      requires: [{ type: 'evidence', kinds: ['failure_classification'], mode: 'any' }],
    },
    close_noop: {
      id: 'close_noop',
      from: { status: 'active', phase: 'classified' },
      to: { status: 'closed', outcome: 'closed_noop' },
      by: ['learning_supervisor'],
      requires: [{ type: 'evidence', kinds: ['no_op_report'] }],
    },
    create_playbook_candidate: {
      id: 'create_playbook_candidate',
      from: { status: 'active', phase: 'classified' },
      to: { status: 'closed', outcome: 'playbook_candidate' },
      by: ['learning_supervisor'],
      requires: [{ type: 'evidence', kinds: ['failure_classification'] }],
    },
    create_policy_candidate: {
      id: 'create_policy_candidate',
      from: { status: 'active', phase: 'classified' },
      to: { status: 'closed', outcome: 'policy_candidate' },
      by: ['learning_supervisor'],
      requires: [{ type: 'evidence', kinds: ['failure_classification'] }],
    },
    quarantine_trace: {
      id: 'quarantine_trace',
      from: { status: 'active' },
      to: { status: 'closed', outcome: 'quarantined' },
      by: ['correlation_steward', 'learning_auditor'],
      requires: [{ type: 'evidence', kinds: ['trace_ingest_report'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningTraceLabelingWorkflowV1 = {
  id: 'learning_trace_labeling',
  version: 1,
  kind: 'learning-task/trace-labeling',
  initial: { status: 'open', phase: 'label_requested' },
  phases: { label_requested: {}, label_proposed: {}, label_reviewed: {} },
  outcomes: { accepted: {}, quarantined: {}, rejected: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    propose_label: {
      id: 'propose_label',
      from: { status: 'open', phase: 'label_requested' },
      to: { status: 'active', phase: 'label_proposed' },
      by: ['trace_reviewer', 'learning_supervisor'],
      requires: [{ type: 'evidence', kinds: ['trace_label'] }],
    },
    review_label: {
      id: 'review_label',
      from: { status: 'active', phase: 'label_proposed' },
      to: { status: 'active', phase: 'label_reviewed' },
      by: ['label_reviewer'],
      requires: [
        { type: 'evidence', kinds: ['label_review'] },
        { type: 'sod', actingRole: 'label_reviewer', notSameAs: ['trace_reviewer'] },
      ],
    },
    accept_label: {
      id: 'accept_label',
      from: { status: 'active', phase: 'label_reviewed' },
      to: { status: 'closed', outcome: 'accepted' },
      by: ['label_reviewer'],
      requires: [{ type: 'evidence', kinds: ['label_review'] }],
    },
    quarantine_label: {
      id: 'quarantine_label',
      from: { status: 'active' },
      to: { status: 'closed', outcome: 'quarantined' },
      by: ['label_reviewer', 'learning_auditor', 'correlation_steward'],
      requires: [{ type: 'evidence', kinds: ['label_review'] }],
    },
    reject_label: {
      id: 'reject_label',
      from: { status: 'active', phase: 'label_reviewed' },
      to: { status: 'closed', outcome: 'rejected' },
      by: ['label_reviewer'],
      requires: [{ type: 'evidence', kinds: ['label_review'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningPlaybookUpdateWorkflowV1 = {
  id: 'learning_playbook_update',
  version: 1,
  kind: 'learning-task/playbook-update',
  initial: { status: 'open', phase: 'drafted' },
  phases: { drafted: {}, reviewed: {}, active: {}, stale: {} },
  outcomes: { active: {}, archived: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    review_playbook: {
      id: 'review_playbook',
      from: { status: 'open', phase: 'drafted' },
      to: { status: 'active', phase: 'reviewed' },
      by: ['playbook_reviewer'],
      requires: [
        { type: 'evidence', kinds: ['playbook_draft', 'playbook_review'] },
        { type: 'sod', actingRole: 'playbook_reviewer', notSameAs: ['playbook_author'] },
      ],
    },
    activate_playbook: {
      id: 'activate_playbook',
      from: { status: 'active', phase: 'reviewed' },
      to: { status: 'closed', outcome: 'active' },
      by: ['playbook_reviewer'],
      requires: [{ type: 'evidence', kinds: ['playbook_review'] }],
    },
    mark_stale: {
      id: 'mark_stale',
      from: { status: 'active' },
      to: { status: 'active', phase: 'stale' },
      by: ['curator', 'playbook_reviewer'],
      requires: [{ type: 'evidence', kinds: ['curation_report'] }],
    },
    archive_playbook: {
      id: 'archive_playbook',
      from: { status: 'active' },
      to: { status: 'closed', outcome: 'archived' },
      by: ['curator', 'playbook_reviewer'],
      requires: [{ type: 'evidence', kinds: ['curation_report'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningCurationWorkflowV1 = {
  id: 'learning_curation',
  version: 1,
  kind: 'learning-task/curation',
  initial: { status: 'open', phase: 'curation_requested' },
  phases: {
    curation_requested: {},
    candidates_collected: {},
    merge_plan_drafted: {},
    reviewed: {},
    applied: {},
  },
  outcomes: { report_written: {}, rejected: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    collect_candidates: {
      id: 'collect_candidates',
      from: { status: 'open', phase: 'curation_requested' },
      to: { status: 'active', phase: 'candidates_collected' },
      by: ['curator'],
    },
    draft_merge_plan: {
      id: 'draft_merge_plan',
      from: { status: 'active', phase: 'candidates_collected' },
      to: { status: 'active', phase: 'merge_plan_drafted' },
      by: ['curator'],
      requires: [{ type: 'evidence', kinds: ['curation_report'] }],
    },
    review_curation: {
      id: 'review_curation',
      from: { status: 'active', phase: 'merge_plan_drafted' },
      to: { status: 'active', phase: 'reviewed' },
      by: ['playbook_reviewer', 'learning_auditor'],
      requires: [{ type: 'sod', actingRole: 'playbook_reviewer', notSameAs: ['curator'] }],
    },
    apply_curation: {
      id: 'apply_curation',
      from: { status: 'active', phase: 'reviewed' },
      to: { status: 'active', phase: 'applied' },
      by: ['curator'],
      requires: [{ type: 'evidence', kinds: ['curation_report'] }],
    },
    write_report: {
      id: 'write_report',
      from: { status: 'active', phase: 'applied' },
      to: { status: 'closed', outcome: 'report_written' },
      by: ['curator'],
      requires: [{ type: 'evidence', kinds: ['curation_report'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningPolicyPatchWorkflowV1 = {
  id: 'learning_policy_patch',
  version: 1,
  kind: 'learning-task/policy-patch',
  initial: { status: 'open', phase: 'candidate' },
  phases: { candidate: {}, patch_bundle_drafted: {}, risk_reviewed: {}, replay_ready: {} },
  outcomes: { evaluation_requested: {}, rejected: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    draft_patch_bundle: {
      id: 'draft_patch_bundle',
      from: { status: 'open', phase: 'candidate' },
      to: { status: 'active', phase: 'patch_bundle_drafted' },
      by: ['patch_author'],
      requires: [{ type: 'evidence', kinds: ['patch_bundle'] }],
    },
    review_risk: {
      id: 'review_risk',
      from: { status: 'active', phase: 'patch_bundle_drafted' },
      to: { status: 'active', phase: 'risk_reviewed' },
      by: ['learning_auditor', 'evaluation_steward'],
      requires: [
        { type: 'evidence', kinds: ['risk_review'] },
        { type: 'sod', actingRole: 'evaluation_steward', notSameAs: ['patch_author'] },
      ],
    },
    prepare_replay: {
      id: 'prepare_replay',
      from: { status: 'active', phase: 'risk_reviewed' },
      to: { status: 'active', phase: 'replay_ready' },
      by: ['evaluator_runner'],
      requires: [{ type: 'evidence', kinds: ['replay_report'] }],
    },
    request_evaluation: {
      id: 'request_evaluation',
      from: { status: 'active', phase: 'replay_ready' },
      to: { status: 'closed', outcome: 'evaluation_requested' },
      by: ['evaluation_steward'],
      requires: [{ type: 'evidence', kinds: ['patch_bundle', 'risk_review', 'replay_report'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningPatchEvaluationWorkflowV1 = {
  id: 'learning_patch_evaluation',
  version: 1,
  kind: 'learning-task/patch-evaluation',
  initial: { status: 'open', phase: 'eval_requested' },
  phases: { eval_requested: {}, replay_run: {}, regression_run: {}, report_attached: {} },
  outcomes: { passed: {}, failed: {}, inconclusive: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    run_replay: {
      id: 'run_replay',
      from: { status: 'open', phase: 'eval_requested' },
      to: { status: 'active', phase: 'replay_run' },
      by: ['evaluator_runner'],
      requires: [{ type: 'evidence', kinds: ['replay_report'] }],
    },
    run_regression: {
      id: 'run_regression',
      from: { status: 'active', phase: 'replay_run' },
      to: { status: 'active', phase: 'regression_run' },
      by: ['evaluator_runner'],
      requires: [{ type: 'evidence', kinds: ['eval_report'] }],
    },
    attach_eval_report: {
      id: 'attach_eval_report',
      from: { status: 'active', phase: 'regression_run' },
      to: { status: 'active', phase: 'report_attached' },
      by: ['evaluation_steward'],
      requires: [
        { type: 'evidence', kinds: ['eval_report'] },
        { type: 'sod', actingRole: 'evaluation_steward', notSameAs: ['patch_author'] },
      ],
    },
    pass: {
      id: 'pass',
      from: { status: 'active', phase: 'report_attached' },
      to: { status: 'closed', outcome: 'passed' },
      by: ['evaluation_steward'],
      requires: [{ type: 'evidence', kinds: ['replay_report', 'eval_report'] }],
    },
    fail: {
      id: 'fail',
      from: { status: 'active', phase: 'report_attached' },
      to: { status: 'closed', outcome: 'failed' },
      by: ['evaluation_steward'],
      requires: [{ type: 'evidence', kinds: ['eval_report'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningPatchPromotionWorkflowV1 = {
  id: 'learning_patch_promotion',
  version: 1,
  kind: 'learning-task/patch-promotion',
  initial: { status: 'open', phase: 'promotion_requested' },
  phases: { promotion_requested: {}, authority_review: {}, staged: {}, canary: {} },
  outcomes: { promoted: {}, rolled_back: {}, rejected: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    authority_review: {
      id: 'authority_review',
      from: { status: 'open', phase: 'promotion_requested' },
      to: { status: 'active', phase: 'authority_review' },
      by: ['promotion_reviewer', 'external_authority'],
      requires: [
        { type: 'evidence', kinds: ['patch_bundle', 'replay_report', 'eval_report'] },
        { type: 'sod', actingRole: 'promotion_reviewer', notSameAs: ['patch_author'] },
      ],
    },
    stage: {
      id: 'stage',
      from: { status: 'active', phase: 'authority_review' },
      to: { status: 'active', phase: 'staged' },
      by: ['promotion_reviewer'],
      requires: [{ type: 'evidence', kinds: ['promotion_readiness_report'] }],
    },
    canary: {
      id: 'canary',
      from: { status: 'active', phase: 'staged' },
      to: { status: 'active', phase: 'canary' },
      by: ['promotion_reviewer'],
      requires: [{ type: 'evidence', kinds: ['promotion_readiness_report'] }],
    },
    promote: {
      id: 'promote',
      from: { status: 'active' },
      to: { status: 'closed', outcome: 'promoted' },
      by: ['external_authority'],
      requires: [
        { type: 'evidence', kinds: ['promotion_readiness_report', 'external_authority_approval'] },
      ],
    },
    reject: {
      id: 'reject',
      from: { status: 'active' },
      to: { status: 'closed', outcome: 'rejected' },
      by: ['promotion_reviewer', 'external_authority'],
      requires: [{ type: 'evidence', kinds: ['promotion_readiness_report'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningRollbackWorkflowV1 = {
  id: 'learning_patch_rollback',
  version: 1,
  kind: 'learning-task/patch-rollback',
  initial: { status: 'open', phase: 'rollback_requested' },
  phases: { rollback_requested: {}, impact_assessed: {}, rollback_plan_verified: {} },
  outcomes: { rolled_back: {}, rejected: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    assess_impact: {
      id: 'assess_impact',
      from: { status: 'open', phase: 'rollback_requested' },
      to: { status: 'active', phase: 'impact_assessed' },
      by: ['learning_auditor', 'promotion_reviewer'],
      requires: [{ type: 'evidence', kinds: ['audit_report'] }],
    },
    verify_rollback_plan: {
      id: 'verify_rollback_plan',
      from: { status: 'active', phase: 'impact_assessed' },
      to: { status: 'active', phase: 'rollback_plan_verified' },
      by: ['promotion_reviewer'],
      requires: [{ type: 'evidence', kinds: ['rollback_plan'] }],
    },
    roll_back: {
      id: 'roll_back',
      from: { status: 'active', phase: 'rollback_plan_verified' },
      to: { status: 'closed', outcome: 'rolled_back' },
      by: ['external_authority'],
      requires: [{ type: 'evidence', kinds: ['rollback_plan', 'external_authority_approval'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningWorkflowPatchWorkflowV1 = {
  id: 'learning_workflow_patch',
  version: 1,
  kind: 'learning-task/learning-workflow-patch',
  initial: { status: 'open', phase: 'learning_patch_candidate' },
  phases: {
    learning_patch_candidate: {},
    meta_eval: {},
    external_review: {},
    staged_next_version: {},
  },
  outcomes: { promoted: {}, rejected: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    run_meta_eval: {
      id: 'run_meta_eval',
      from: { status: 'open', phase: 'learning_patch_candidate' },
      to: { status: 'active', phase: 'meta_eval' },
      by: ['evaluator_runner'],
      requires: [{ type: 'evidence', kinds: ['meta_eval_report'] }],
    },
    external_review: {
      id: 'external_review',
      from: { status: 'active', phase: 'meta_eval' },
      to: { status: 'active', phase: 'external_review' },
      by: ['external_authority'],
      requires: [{ type: 'evidence', kinds: ['meta_eval_report', 'external_authority_approval'] }],
    },
    stage_next_version: {
      id: 'stage_next_version',
      from: { status: 'active', phase: 'external_review' },
      to: { status: 'active', phase: 'staged_next_version' },
      by: ['external_authority'],
      requires: [{ type: 'evidence', kinds: ['external_authority_approval'] }],
    },
    promote_future_version: {
      id: 'promote_future_version',
      from: { status: 'active', phase: 'staged_next_version' },
      to: { status: 'closed', outcome: 'promoted' },
      by: ['external_authority'],
      requires: [{ type: 'evidence', kinds: ['external_authority_approval'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningAuditWorkflowV1 = {
  id: 'learning_audit',
  version: 1,
  kind: 'learning-task/audit',
  initial: { status: 'open', phase: 'audit_requested' },
  phases: { audit_requested: {}, evidence_collected: {}, reviewed: {} },
  outcomes: { closed: {}, quarantined: {}, promotion_blocked: {} },
  roles: learningRoles,
  evidenceKinds: commonLearningEvidence,
  transitions: {
    collect_evidence: {
      id: 'collect_evidence',
      from: { status: 'open', phase: 'audit_requested' },
      to: { status: 'active', phase: 'evidence_collected' },
      by: ['learning_auditor'],
      requires: [{ type: 'evidence', kinds: ['audit_report'] }],
    },
    review_audit: {
      id: 'review_audit',
      from: { status: 'active', phase: 'evidence_collected' },
      to: { status: 'active', phase: 'reviewed' },
      by: ['external_authority', 'learning_auditor'],
      requires: [{ type: 'evidence', kinds: ['audit_report'] }],
    },
    quarantine_artifact: {
      id: 'quarantine_artifact',
      from: { status: 'active', phase: 'reviewed' },
      to: { status: 'closed', outcome: 'quarantined' },
      by: ['learning_auditor', 'external_authority'],
      requires: [{ type: 'evidence', kinds: ['audit_report'] }],
    },
    block_promotion: {
      id: 'block_promotion',
      from: { status: 'active', phase: 'reviewed' },
      to: { status: 'closed', outcome: 'promotion_blocked' },
      by: ['learning_auditor', 'external_authority'],
      requires: [{ type: 'evidence', kinds: ['audit_report'] }],
    },
  },
} satisfies WorkflowDefinition

export const learningWorkflowDefinitionsV1 = [
  learningTraceTriageWorkflowV1,
  learningTraceLabelingWorkflowV1,
  learningPlaybookUpdateWorkflowV1,
  learningCurationWorkflowV1,
  learningPolicyPatchWorkflowV1,
  learningPatchEvaluationWorkflowV1,
  learningPatchPromotionWorkflowV1,
  learningRollbackWorkflowV1,
  learningWorkflowPatchWorkflowV1,
  learningAuditWorkflowV1,
] as const

export const builtInWorkflowDefinitions = [
  basicWorkflowV1,
  codeDefectFastlaneWorkflowV1,
  codeFeatureTddWorkflowV1,
  ...learningWorkflowDefinitionsV1,
] as const
