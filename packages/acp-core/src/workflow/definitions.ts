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

export const builtInWorkflowDefinitions = [
  basicWorkflowV1,
  codeDefectFastlaneWorkflowV1,
  codeFeatureTddWorkflowV1,
] as const
