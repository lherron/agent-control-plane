import { describe, expect, test } from 'bun:test'

import {
  PBC_WORKFLOW_TEMPLATE_REF,
  getPhaseGuidance,
  getTransitionGuidance,
  projectPbcTemplateModelFromWorkflowShow,
} from './pbc-template-model.js'

const NEXT_ACTION_MODEL = {
  schemaVersion: 'wrkf.next-action-model.v1',
  scope: {
    required: true,
    source: 'participantRun.sessionRef.scopeRef',
    defaultShape: 'agent:<agentId>:project:<projectId>:task:<taskId>:role:<role>',
    allowedKinds: ['project-task-role', 'project-task', 'project-role'],
    laneDefault: 'pbc-refinement',
    handoffPolicy: 'same-scope-or-authorized-descendant',
  },
  promptCatalog: {
    'pbc.agent.base.v5': {
      kind: 'workflow-guidance',
      summary: 'Base instructions',
      templateRefs: ['pbc/templates/behavior-note.md'],
    },
  },
  roles: {
    agent: {
      basePromptRef: 'pbc.agent.base.v5',
      purpose: 'Normalize feedback and draft PBCs.',
      hardRules: ['Use wrkf next as the source of legal next actions.'],
    },
    product_owner: {
      basePromptRef: 'pbc.product_owner.base.v5',
      purpose: 'Answer blocking decisions.',
      hardRules: ['Answer only the blocking decision requested by the workflow.'],
    },
  },
  phaseGuidance: {
    'active/pressure': {
      agentInstruction: 'Run the pressure pass.',
      expectedEvidence: ['pressure_pass', 'pbc_final when verdict is ready'],
      avoid: ['finalizing without pressure_pass.verdict=ready'],
    },
  },
  transitionGuidance: {
    finalize_ready_pbc: {
      prompt: 'Only finalize if pressure_pass.verdict is ready.',
      produceEvidence: ['pressure_pass', 'pbc_final'],
      operatorHint: 'Apply finalize_ready_pbc only with distinct actors.',
    },
  },
}

describe('PBC template model projection', () => {
  test('exports the Phase 1 default template ref', () => {
    expect(PBC_WORKFLOW_TEMPLATE_REF).toBe('pbc-progressive-refinement@5')
  })

  test('projects nextActionModel from workflow.show and supports phase/transition lookup', () => {
    const model = projectPbcTemplateModelFromWorkflowShow({
      ref: 'pbc-progressive-refinement@5',
      nextActionModel: NEXT_ACTION_MODEL,
    })

    expect(model.scope.laneDefault).toBe('pbc-refinement')
    expect(model.roles['agent']?.hardRules).toContain(
      'Use wrkf next as the source of legal next actions.'
    )

    const pressure = getPhaseGuidance(model, { status: 'active', phase: 'pressure' })
    expect(pressure?.agentInstruction).toBe('Run the pressure pass.')
    expect(pressure?.expectedEvidence).toEqual(['pressure_pass', 'pbc_final when verdict is ready'])

    const finalize = getTransitionGuidance(model, 'finalize_ready_pbc')
    expect(finalize?.produceEvidence).toEqual(['pressure_pass', 'pbc_final'])
    expect(finalize?.operatorHint).toBe('Apply finalize_ready_pbc only with distinct actors.')
  })

  test('throws clear errors for missing or malformed nextActionModel', () => {
    expect(() => projectPbcTemplateModelFromWorkflowShow({})).toThrow(
      'workflow.nextActionModel must be an object'
    )
    expect(() =>
      projectPbcTemplateModelFromWorkflowShow({
        nextActionModel: { ...NEXT_ACTION_MODEL, roles: [] },
      })
    ).toThrow('workflow.nextActionModel.roles must be an object')
    expect(() =>
      projectPbcTemplateModelFromWorkflowShow({
        nextActionModel: {
          ...NEXT_ACTION_MODEL,
          phaseGuidance: {
            'active/pressure': { expectedEvidence: ['pressure_pass'] },
          },
        },
      })
    ).toThrow(
      'workflow.nextActionModel.phaseGuidance.active/pressure.agentInstruction must be a non-empty string'
    )
  })
})
