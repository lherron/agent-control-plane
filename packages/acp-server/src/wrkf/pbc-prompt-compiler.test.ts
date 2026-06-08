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
import { type PromptCompileInput, compilePbcPrompt } from './pbc-prompt-compiler.js'

import { projectPbcTemplateModel } from './pbc-template-model.js'
import type { EvidenceRecord, NextActionResponse, ObligationRecord } from './projections.js'

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
  // --- basic shape -----------------------------------------------------------

  test('returns a non-empty string', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  // --- phase guidance -------------------------------------------------------

  test('includes agentInstruction for the current state (active/pressure)', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('Run the pressure pass and produce pressure_pass evidence.')
  })

  test('does not include agentInstruction for a different state (active/behavior_note)', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // The behavior_note guidance must not bleed into the pressure prompt
    expect(result).not.toContain('Produce behavior_note and pre_interview_analysis evidence.')
  })

  test('selects phase guidance by status+phase from the template', () => {
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
    expect(result).toContain('pressure_pass')
    expect(result).toContain('pbc_final')
  })

  // --- blocked transition guidance ------------------------------------------

  test('includes blocked transition names', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // run_pressure_pass is in next.blockedTransitions
    expect(result).toContain('run_pressure_pass')
  })

  test('includes blocked transition reason when present', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('pressure pass already submitted')
  })

  // --- open obligations -----------------------------------------------------

  test('includes open obligation kind when obligations are present', () => {
    const inputWithObligation: PromptCompileInput = {
      ...BASE_INPUT,
      obligations: [
        {
          id: 'obl_clr_1',
          kind: 'clarification_response',
          status: 'open',
          raw: {},
        } satisfies ObligationRecord,
      ],
    }
    const result = compilePbcPrompt(inputWithObligation)
    expect(result).toContain('clarification_response')
  })

  test('includes multiple open obligations', () => {
    const inputWithObligations: PromptCompileInput = {
      ...BASE_INPUT,
      obligations: [
        {
          id: 'obl_1',
          kind: 'clarification_response',
          status: 'open',
          raw: {},
        } satisfies ObligationRecord,
        { id: 'obl_2', kind: 'patch_decision', status: 'open', raw: {} } satisfies ObligationRecord,
      ],
    }
    const result = compilePbcPrompt(inputWithObligations)
    expect(result).toContain('clarification_response')
    expect(result).toContain('patch_decision')
  })

  // --- ParticipantOutput schema ---------------------------------------------

  test('embeds the ParticipantOutput schema with evidence array field', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // The schema must include the "evidence" field description
    expect(result).toContain('evidence')
  })

  test('embeds the ParticipantOutput schema with proposedTransition field', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('proposedTransition')
  })

  test('embeds the ParticipantOutput schema with satisfyObligations field', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('satisfyObligations')
  })

  test('embeds the ParticipantOutput schema with summary field', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    expect(result).toContain('summary')
  })

  // --- system-level guardrails ----------------------------------------------

  test('includes guardrail: participant must not call wrkf directly', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // Must include some form of "do not call wrkf" instruction
    expect(result.toLowerCase()).toMatch(
      /do not.*wrkf|must not.*wrkf|no direct.*wrkf|wrkf.*directly/i
    )
  })

  test('includes guardrail: participant must not apply transitions', () => {
    const result = compilePbcPrompt(BASE_INPUT)
    // Must tell participant that the harness applies transitions, not the participant
    expect(result.toLowerCase()).toMatch(
      /do not.*apply.*transition|must not.*transition|harness.*applies.*transition/i
    )
  })

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
