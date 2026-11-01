import { describe, expect, test } from 'bun:test'
import {
  type FakeWorkerPort,
  makeEvidenceRecord,
  makeFakeWorkerPort,
  makeNextRaw,
} from '../../test/fixtures/pbc-worker.js'
import { runPbcContinuationWorker } from './worker.js'

// ===========================================================================
// 10. WORKER PROMPT CONTENT (T-03678)
//
// RED tests: compileWorkerPrompt / tryCompileTemplatePrompt must embed the
// task's actual product feedback and prior-evidence CONTENT in the compiled
// prompt so the agent can produce grounded PBC evidence — not content-blind
// output about the prompt contract itself.
//
// Current behavior (RED): compilePbcPrompt renders prior evidence as a
// summary-only list ("- intake_metadata (id: ev_1)"). The rawFeedback string,
// behavior_note content, clarification_response answer, and pbc_draft content
// are NOT included. The agent literally cannot see the product feedback.
//
// Expected behavior (post-fix): the compiled prompt includes a CONTEXT section
// with the actual content of relevant prior evidence so the agent writes PBC
// evidence grounded in the real feedback (e.g. "dark mode toggle").
// ===========================================================================

/**
 * Minimal valid PBC template embedded on next.instance.template so
 * tryCompileTemplatePrompt takes the template path (not the fallback).
 */
const PROMPT_CONTENT_TEMPLATE: Record<string, unknown> = {
  nextActionModel: {
    schemaVersion: 'wrkf.next-action-model.v1',
    scope: { allowedKinds: [] },
    promptCatalog: {},
    roles: {
      agent: {
        hardRules: ['Ground all evidence in the actual task context.'],
      },
      pressure_reviewer: {
        hardRules: ['Review the pbc_draft for quality and fidelity to the product feedback.'],
      },
    },
    phaseGuidance: {
      'active/behavior_note': {
        agentInstruction:
          'Produce behavior_note and pre_interview_analysis based on the product feedback.',
        expectedEvidence: ['behavior_note', 'pre_interview_analysis'],
        blockedBy: [],
        avoid: [],
      },
      'active/pbc_draft': {
        agentInstruction: 'Draft the PBC grounded in the behavior note and clarification response.',
        expectedEvidence: ['pbc_draft'],
        blockedBy: [],
        avoid: [],
      },
      'active/pressure': {
        agentInstruction: 'Review the pbc_draft and produce pressure_pass evidence.',
        expectedEvidence: ['pressure_pass', 'pbc_final when ready'],
        blockedBy: [],
        avoid: [],
      },
    },
    transitionGuidance: {
      draft_pbc: {
        prompt: 'Propose draft_pbc after producing behavior_note.',
        produceEvidence: ['behavior_note'],
        satisfyObligations: [],
      },
      run_pressure_pass: {
        prompt: 'Propose run_pressure_pass after completing the draft.',
        produceEvidence: ['pbc_draft'],
        satisfyObligations: [],
      },
      finalize_ready_pbc: {
        prompt: 'Propose finalize_ready_pbc when pressure_pass verdict is ready.',
        produceEvidence: ['pbc_final'],
        satisfyObligations: [],
      },
    },
  },
}

/**
 * Build a raw next response for a given phase with PROMPT_CONTENT_TEMPLATE
 * embedded on instance.template so tryCompileTemplatePrompt takes the
 * template path rather than falling back to the bare prompt.
 */
function makeNextRawWithTemplate(opts: {
  phase: string
  revision?: number
  actions?: Array<{ transition: string; role?: string }>
}): Record<string, unknown> {
  const base = makeNextRaw({
    status: 'active',
    phase: opts.phase,
    revision: opts.revision ?? 1,
    actions: opts.actions ?? [],
  })
  // Inject template onto instance so tryCompileTemplatePrompt is exercised
  ;(base['instance'] as Record<string, unknown>)['template'] = PROMPT_CONTENT_TEMPLATE
  return base
}

/**
 * Extract the prompt string passed to launchAcpRun from the call spy.
 * Returns undefined when launchAcpRun was never called.
 */
function extractLaunchPrompt(port: FakeWorkerPort): string | undefined {
  const call = port._calls.find((c) => c.method === 'launchAcpRun')
  if (call === undefined) return undefined
  return (call.params as Record<string, unknown>)['prompt'] as string | undefined
}

const RAW_FEEDBACK = 'dark mode toggle is missing from the settings page'
const BN_CONTENT = 'User expects a dark-mode toggle in Settings > Display.'
const CLARIF_ANSWER = 'Settings > Display > Theme — add a dark/light toggle control.'
const DRAFT_CONTENT =
  'When the user navigates to Settings > Display, they see a dark mode toggle that persists across sessions.'
const DRAFT_EVIDENCE_ID = 'ev_draft_1'

const DRAFT_PHASE_EVIDENCE = [
  makeEvidenceRecord('ev_intake_1', 'intake_metadata', {
    facts: { rawFeedback: 'dark mode toggle is missing' },
  }),
  makeEvidenceRecord('ev_bn_1', 'behavior_note', { facts: { content: BN_CONTENT } }),
  makeEvidenceRecord('ev_cr_1', 'clarification_response', { facts: { answer: CLARIF_ANSWER } }),
]
const PRESSURE_PHASE_EVIDENCE = [
  makeEvidenceRecord('ev_bn_1', 'behavior_note', {
    facts: { content: 'User expects dark mode toggle in Settings.' },
  }),
  makeEvidenceRecord(DRAFT_EVIDENCE_ID, 'pbc_draft', {
    facts: { content: DRAFT_CONTENT, iteration: 1 },
  }),
]

describe('runPbcContinuationWorker — worker prompt content (T-03678 template path, T-03755 fallback path)', () => {
  // T-03678: the template path must embed prior-evidence CONTENT, not a summary list.
  // T-03755: the fallback path (no next.instance.template — the live production case)
  // must embed the same CONTEXT section, plus the draft evidence id the reviewer copies
  // into reviewedDraftEvidenceId.
  test.each([
    {
      path: 'template',
      phase: 'behavior_note',
      revision: 1,
      actions: [{ transition: 'draft_pbc' }],
      evidence: [
        makeEvidenceRecord('ev_intake_1', 'intake_metadata', {
          facts: { rawFeedback: RAW_FEEDBACK },
        }),
      ],
      pressureActor: undefined,
      mustContain: [RAW_FEEDBACK],
    },
    {
      path: 'template',
      phase: 'pbc_draft',
      revision: 3,
      actions: [{ transition: 'run_pressure_pass' }],
      evidence: DRAFT_PHASE_EVIDENCE,
      pressureActor: undefined,
      mustContain: [BN_CONTENT, CLARIF_ANSWER],
    },
    {
      path: 'template',
      phase: 'pressure',
      revision: 5,
      // explicit pressure_reviewer role so participantFor returns pressure_reviewer
      actions: [{ transition: 'finalize_ready_pbc', role: 'pressure_reviewer' }],
      evidence: PRESSURE_PHASE_EVIDENCE,
      pressureActor: 'agent:pbc-reviewer',
      mustContain: [DRAFT_CONTENT],
    },
    {
      path: 'fallback',
      phase: 'behavior_note',
      revision: 1,
      actions: [{ transition: 'draft_pbc' }],
      evidence: [
        makeEvidenceRecord('ev_intake_1', 'intake_metadata', {
          facts: { rawFeedback: RAW_FEEDBACK },
        }),
      ],
      pressureActor: undefined,
      mustContain: [RAW_FEEDBACK],
    },
    {
      path: 'fallback',
      phase: 'pbc_draft',
      revision: 3,
      actions: [{ transition: 'run_pressure_pass' }],
      evidence: DRAFT_PHASE_EVIDENCE,
      pressureActor: undefined,
      mustContain: [BN_CONTENT, CLARIF_ANSWER],
    },
    {
      path: 'fallback',
      phase: 'pressure',
      revision: 5,
      // non-finalization transition avoids the SoD stop check
      actions: [{ transition: 'request_patch_decision' }],
      evidence: PRESSURE_PHASE_EVIDENCE,
      pressureActor: 'agent:pbc-reviewer',
      mustContain: [DRAFT_CONTENT, DRAFT_EVIDENCE_ID],
    },
  ])(
    'the $phase launch prompt ($path path) embeds the prior evidence content the phase needs',
    async ({ path, phase, revision, actions, evidence, pressureActor, mustContain }) => {
      const next =
        path === 'template'
          ? makeNextRawWithTemplate({ phase, revision, actions })
          : makeNextRaw({ status: 'active', phase, revision, actions })
      const port = makeFakeWorkerPort({
        // finalText undefined → awaiting path; launchAcpRun still fires first
        finalText: undefined,
        evidence,
        nextSequence: [next],
      })

      await runPbcContinuationWorker(port, {
        taskId: `T-prompt-${path}-${phase}`,
        idempotencyKey: `prompt-content-${path}-${phase}`,
        actor: 'agent:pbc-writer',
        ...(pressureActor !== undefined ? { pressureActor } : {}),
      })

      const prompt = extractLaunchPrompt(port)
      expect(prompt).toBeDefined()
      for (const text of mustContain) {
        expect(prompt).toContain(text)
      }
    }
  )

  // ── Test 4 (GREEN): strict-JSON directive + per-phase schema always present ──
  //
  // These are already appended by compileWorkerPrompt / compilePbcPrompt today.
  // This test MUST STAY GREEN through the fix and serve as a regression guard.

  test('compiled prompt instructs the wrkf evidence loop, not a JSON-emit contract', async () => {
    const port = makeFakeWorkerPort({
      finalText: undefined,
      evidence: [],
      nextSequence: [
        makeNextRawWithTemplate({
          phase: 'behavior_note',
          revision: 1,
          actions: [{ transition: 'draft_pbc' }],
        }),
      ],
    })

    await runPbcContinuationWorker(port, {
      taskId: 'T-03678-schema',
      idempotencyKey: 'prompt-content-schema-01',
      actor: 'agent:pbc-writer',
    })

    const prompt = extractLaunchPrompt(port)
    expect(prompt).toBeDefined()
    // The agent records evidence by driving the wrkf CLI directly.
    expect(prompt).toContain('wrkf evidence add')
    expect(prompt).toContain('wrkf next')
    expect(prompt).toContain('Do NOT run `wrkf transition`')
    // The old strict-JSON-emit contract is gone.
    expect(prompt).not.toContain('## Output contract — STRICT')
    expect(prompt).not.toContain('ParticipantOutput')
  })
})
