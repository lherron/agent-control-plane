import { deepFreeze } from '../models/preset.js'
import type { Preset } from '../models/preset.js'

const codeFeatureTddPreset = {
  presetId: 'code_feature_tdd',
  version: 1,
  kind: 'code_change',
  phaseGraph: ['scoped', 'ready', 'red', 'green', 'refactor', 'tested', 'accepted', 'released'],
  defaultRoles: ['owner', 'implementer', 'tester'],
  transitionPolicy: [
    {
      fromPhase: 'scoped',
      toPhase: 'ready',
      allowedRoles: ['owner'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['scope_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'ready',
      toPhase: 'red',
      allowedRoles: ['implementer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['tdd_red_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'red',
      toPhase: 'green',
      allowedRoles: ['implementer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['tdd_green_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'green',
      toPhase: 'refactor',
      allowedRoles: ['implementer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['refactor_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'refactor',
      toPhase: 'tested',
      allowedRoles: ['tester'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['qa_bundle'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'refactor',
      toPhase: 'tested',
      allowedRoles: ['tester'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['ci_report'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'tested',
      toPhase: 'accepted',
      allowedRoles: ['owner', 'reviewer'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['acceptance_signoff'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'accepted',
      toPhase: 'released',
      allowedRoles: ['release_manager', 'owner'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['release_ref'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'accepted',
      toPhase: 'released',
      allowedRoles: ['release_manager', 'owner'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['deploy_ref'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'accepted',
      toPhase: 'released',
      allowedRoles: ['release_manager', 'owner'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: ['merge_ref'],
      waiverKinds: ['evidence_override'],
      riskClasses: ['low', 'medium', 'high'],
    },
    {
      fromPhase: 'released',
      toPhase: 'completed',
      allowedRoles: ['owner', 'release_manager'],
      disallowSameAgentAsRoles: [],
      requiredEvidenceKinds: [],
      riskClasses: ['low', 'medium', 'high'],
    },
  ],
  guidance: {
    scoped: {
      objective: 'Define the feature scope and acceptance boundary.',
      doneWhen: [
        'the intended behavior is narrow enough to test',
        'the scope bundle is attached to the task',
      ],
      suggestedEvidence: ['scope_bundle'],
      agentHints: [
        'Keep scope explicit before implementation starts',
        'Capture exclusions when they prevent ambiguous acceptance',
      ],
    },
    ready: {
      objective: 'Prepare the failing TDD proof.',
      doneWhen: ['test approach is clear', 'the next transition can attach a failing proof'],
      suggestedEvidence: ['tdd_red_bundle'],
      agentHints: [
        'Do not skip the red proof',
        'Prefer deterministic tests over broad manual repro notes',
      ],
    },
    red: {
      objective: 'Capture a failing proof before changing code.',
      doneWhen: [
        'failing test or deterministic repro exists',
        'failure evidence is attached to the task',
      ],
      suggestedEvidence: ['tdd_red_bundle'],
      agentHints: [
        'Keep the failing case narrow',
        'Make the red proof easy for the tester to rerun',
      ],
    },
    green: {
      objective: 'Implement the feature until the red proof passes.',
      doneWhen: [
        'the implementation is linked to code changes',
        'green proof is attached to the task',
      ],
      suggestedEvidence: ['tdd_green_bundle'],
      agentHints: [
        'Prefer a direct implementation before cleanup',
        'Preserve the failing proof as regression coverage',
      ],
    },
    refactor: {
      objective: 'Clean up the implementation without changing behavior.',
      doneWhen: ['refactor evidence captures the cleanup', 'behavioral proof remains green'],
      suggestedEvidence: ['refactor_bundle'],
      agentHints: [
        'Keep refactors tied to the implemented feature',
        'Avoid expanding scope during cleanup',
      ],
    },
    tested: {
      objective: 'Verify the feature through QA or CI evidence.',
      doneWhen: [
        'QA or CI evidence is attached',
        'test results match the scoped acceptance criteria',
      ],
      suggestedEvidence: ['qa_bundle', 'ci_report'],
      agentHints: [
        'Use the assigned tester when manual QA is needed',
        'CI evidence is sufficient when it covers the acceptance path',
      ],
    },
    accepted: {
      objective: 'Record owner acceptance.',
      doneWhen: ['acceptance signoff is attached', 'release path is clear'],
      suggestedEvidence: ['acceptance_signoff'],
      agentHints: [
        'Keep acceptance tied to the original scope',
        'Call out follow-up work separately instead of widening this task',
      ],
    },
    released: {
      objective: 'Attach release provenance and close the workflow lifecycle.',
      doneWhen: [
        'release, deploy, or merge reference is attached',
        'the task lifecycle can move to completed',
      ],
      suggestedEvidence: ['release_ref', 'deploy_ref', 'merge_ref'],
      agentHints: [
        'Use the most concrete release reference available',
        'Do not add a completed phase; completion is lifecycle state',
      ],
    },
  },
} satisfies Preset

export const codeFeatureTddV1 = deepFreeze(codeFeatureTddPreset) as Preset
