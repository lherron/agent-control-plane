/**
 * Red tests for pbc-prompt-compiler.ts (Phase 2).
 *
 * Defines the contract for compilePbcPrompt(input: PromptCompileInput): string.
 * All tests will fail until the module is implemented — that is by design.
 *
 * Contract summary (SPEC §4.8):
 *   - Select phase guidance by next.instance.state.status+phase from template.phaseGuidance
 *   - Emit role hard rules from template.roles[role].hardRules
 *   - Emit transition guidance (prompt text) for every candidate next action
 *   - Emit blocked transition names and reasons
 *   - Emit open obligations and their required evidence kinds
 *   - Embed the exact ParticipantOutput JSON schema (evidence[], satisfyObligations?,
 *     proposedTransition?, summary?)
 *   - Add system-level guardrails: no direct wrkf calls, no transition application,
 *     agent must not fabricate product_owner obligations
 */

import { describe, expect, test } from 'bun:test'

// These imports define the module contract. They will fail until the module exists.
import { type PromptCompileInput, compilePbcPrompt } from './prompt-compiler.js'

import type { EvidenceRecord, NextActionResponse, ObligationRecord } from '../../projections.js'
import { projectPbcTemplateModel } from './template-model.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TEMPLATE_FIXTURE = projectPbcTemplateModel(
  {
    schemaVersion: 'wrkf.next-action-model.v1',
    scope: {
      required: true,
      source: 'participantRun.sessionRef.scopeRef',
      allowedKinds: ['project-task-role'],
      laneDefault: 'pbc-refinement',
    },
    promptCatalog: {},
    roles: {
      agent: {
        purpose: 'Normalize feedback and draft PBCs.',
        hardRules: [
          'Use wrkf next as the authoritative source of legal next actions.',
          'Produce evidence in the required ParticipantOutput format.',
        ],
      },
      product_owner: {
        purpose: 'Answer blocking decisions.',
        hardRules: ['Answer only the blocking decision currently requested by the workflow.'],
      },
    },
    phaseGuidance: {
      'active/pressure': {
        agentInstruction:
          'Run the pressure pass and produce pressure_pass evidence. If verdict is ready, also produce pbc_final.',
        expectedEvidence: ['pressure_pass', 'pbc_final when verdict is ready'],
        blockedBy: ['pbc_draft must exist before pressure pass'],
        avoid: ['finalizing without pressure_pass.verdict=ready'],
      },
      'active/behavior_note': {
        agentInstruction:
          'Produce behavior_note and pre_interview_analysis evidence. Set clarification_needed correctly.',
        expectedEvidence: ['behavior_note', 'pre_interview_analysis'],
        blockedBy: [],
        avoid: ['skipping pre_interview_analysis'],
      },
    },
    transitionGuidance: {
      finalize_ready_pbc: {
        prompt: 'Propose finalize_ready_pbc only when pressure_pass.verdict is ready.',
        produceEvidence: ['pressure_pass', 'pbc_final'],
        satisfyObligations: [],
        operatorHint: 'Apply finalize_ready_pbc only with a distinct pressure reviewer actor.',
      },
      run_pressure_pass: {
        prompt: 'Apply run_pressure_pass after producing valid pressure_pass evidence.',
        produceEvidence: ['pressure_pass'],
        satisfyObligations: [],
      },
    },
  },
  'nextActionModel'
)

/** next response with the instance in active/pressure */
const NEXT_IN_PRESSURE: NextActionResponse = {
  instance: {
    state: { status: 'active', phase: 'pressure' },
    revision: 5,
    contextHash: 'sha256:ctx5abc',
    raw: {},
  },
  actions: [{ transition: 'finalize_ready_pbc', role: 'agent', raw: {} }],
  blockedTransitions: [
    { transition: 'run_pressure_pass', reason: 'pressure pass already submitted', raw: {} },
  ],
  openObligations: [],
  pendingEffects: [],
  raw: {},
}

const BASE_INPUT: PromptCompileInput = {
  template: TEMPLATE_FIXTURE,
  task: 'T-02033',
  role: 'agent',
  actor: 'agent:pbc-writer',
  next: NEXT_IN_PRESSURE,
  evidenceSummaries: [],
  obligations: [],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compilePbcPrompt', () => {
  // --- phase guidance -------------------------------------------------------

  test("prompt carries only the current status/phase's agentInstruction", () => {
    // active/pressure: pressure guidance present, behavior_note guidance must not bleed in
    const pressurePrompt = compilePbcPrompt(BASE_INPUT)
    expect(pressurePrompt).toContain('Run the pressure pass and produce pressure_pass evidence.')
    expect(pressurePrompt).not.toContain(
      'Produce behavior_note and pre_interview_analysis evidence.'
    )

    // Switch to active/behavior_note
    const inputInBehaviorNote: PromptCompileInput = {
      ...BASE_INPUT,
      next: {
        ...NEXT_IN_PRESSURE,
        instance: {
          ...NEXT_IN_PRESSURE.instance,
          state: { status: 'active', phase: 'behavior_note' },
        },
        actions: [{ transition: 'draft_pbc', role: 'agent', raw: {} }],
        blockedTransitions: [],
      },
    }
    const result = compilePbcPrompt(inputInBehaviorNote)
    expect(result).toContain('Produce behavior_note and pre_interview_analysis evidence.')
    expect(result).not.toContain('Run the pressure pass and produce pressure_pass evidence.')
  })

  // --- role hard rules ------------------------------------------------------

  test('includes all hard rules for the agent role', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('Use wrkf next as the authoritative source of legal next actions.')
    expect(result).toContain('Produce evidence in the required ParticipantOutput format.')
  })

  test('includes hard rules for product_owner role when role=product_owner', () => {
    const poInput: PromptCompileInput = {
      ...BASE_INPUT,
      role: 'product_owner',
      actor: 'human:product-owner',
    }
    const result = compilePbcPrompt(poInput)
    expect(result).toContain(
      'Answer only the blocking decision currently requested by the workflow.'
    )
  })

  // --- candidate transition guidance ----------------------------------------

  test('includes transition guidance prompt for candidate next actions', () => {
    // finalize_ready_pbc is in next.actions
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('finalize_ready_pbc')
    expect(result).toContain('Propose finalize_ready_pbc only when pressure_pass.verdict is ready.')
  })

  test('includes evidence to produce for candidate transitions', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // finalize_ready_pbc.produceEvidence = ['pressure_pass', 'pbc_final']
    expect(result).toContain('Evidence to produce: pressure_pass, pbc_final')
  })

  // --- blocked transition guidance ------------------------------------------

  test('lists each blocked transition by name with its reason', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // run_pressure_pass is in next.blockedTransitions
    expect(result).toContain('- run_pressure_pass — pressure pass already submitted')
  })

  // --- open obligations -----------------------------------------------------

  test('lists every open obligation with its id and status', () => {
    const inputWithObligations: PromptCompileInput = {
      ...BASE_INPUT,
      obligations: [
        {
          id: 'obl_clr_1',
          kind: 'clarification_response',
          status: 'open',
          raw: {},
        } satisfies ObligationRecord,
        { id: 'obl_2', kind: 'patch_decision', status: 'open', raw: {} } satisfies ObligationRecord,
      ],
    }
    const result = compilePbcPrompt(inputWithObligations)
    expect(result).toContain('- clarification_response (id: obl_clr_1, status: open)')
    expect(result).toContain('- patch_decision (id: obl_2, status: open)')
  })

  // --- wrkf evidence loop (direct-wrkf recording) ---------------------------

  test('points the participant at wrkf evidence schema for the kind contract', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('wrkf evidence schema')
  })

  test('instructs use of --json so validation errors come back structured', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('--json')
    expect(result).toContain('fix')
  })

  // --- system-level guardrails ----------------------------------------------

  test('includes guardrail: agent must not fabricate product_owner obligation evidence', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // product_owner fabrication guardrail is a system-level rule that must always appear
    // even when the template's agent.hardRules do not mention it
    expect(result.toLowerCase()).toMatch(/product.?owner/i)
    expect(result.toLowerCase()).toMatch(/fabricat|synthesiz|must not.*produc.*product.?owner/i)
  })

  // --- evidence summaries context -------------------------------------------

  test('includes evidence summary context when evidenceSummaries are provided', () => {
    const inputWithEvidence: PromptCompileInput = {
      ...BASE_INPUT,
      evidenceSummaries: [
        {
          id: 'ev_1',
          kind: 'pbc_draft',
          summary: 'First PBC draft submitted',
          raw: {},
        } satisfies EvidenceRecord,
      ],
    }
    const result = compilePbcPrompt(inputWithEvidence)
    // Existing evidence summaries should be surfaced to the participant for context
    expect(result).toContain('pbc_draft')
    expect(result).toContain('First PBC draft submitted')
  })
})

describe('participant transition guardrail', () => {
  test('includes guardrail: participant must not apply transitions', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // Must tell participant that the harness applies transitions, not the participant
    expect(result.toLowerCase()).toMatch(
      /do not.*apply.*transition|must not.*transition|harness.*applies.*transition/i
    )
  })
})
