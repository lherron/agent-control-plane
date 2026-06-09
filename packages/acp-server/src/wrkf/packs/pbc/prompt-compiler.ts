/**
 * PBC harness Phase 2 — role-scoped prompt compiler (SPEC §4.8).
 *
 * compilePbcPrompt() builds the participant-facing prompt entirely from the
 * installed PBC template's nextActionModel (the projected PbcTemplateModel) plus
 * the live `next` projection. It MUST NOT hard-code phase text: all phase /
 * transition guidance comes from the template.
 *
 * The compiler tells the participant to PRODUCE evidence + recommendations only.
 * The harness (not the participant) writes to wrkf and applies transitions.
 */

import {
  type PbcTemplateModel,
  getPhaseGuidance,
  getTransitionGuidance,
} from './template-model.js'
import type { EvidenceRecord, NextActionResponse, ObligationRecord } from '../../projections.js'

export interface PromptCompileInput {
  template: PbcTemplateModel
  task: string
  role: string
  actor: string
  scopeRef?: string | undefined
  laneRef?: string | undefined
  next: NextActionResponse
  evidenceSummaries: EvidenceRecord[]
  obligations: ObligationRecord[]
}

/** Evidence kinds that only a product_owner participant may legitimately produce. */
const PRODUCT_OWNER_EVIDENCE_KINDS = ['clarification_response', 'patch_decision']

/** Roles driven by the autonomous worker (vs. human /input product_owner). */
const AGENT_PARTICIPANT_ROLES = ['agent', 'pressure_reviewer']

/**
 * Exact per-phase evidence the autonomous participant MUST emit in a single turn,
 * keyed by the workflow phase (next.instance.state.phase). The shapes mirror the
 * PBC evidence policy (required facts) and the freshness gate (linkage ids carried
 * in `data`). Embedding them verbatim is what lets a general agent (larry/curly)
 * produce complete, valid output so the workflow advances autonomously (T-03595).
 */
interface PhaseEvidenceItem {
  /** When 'conditional', only emit it when `when` holds. */
  required: 'always' | 'conditional'
  when?: string
  /** A concrete JSON example of the evidence record to emit. */
  example: string
}

const PER_PHASE_EVIDENCE: Record<string, { intro: string; items: PhaseEvidenceItem[] }> = {
  behavior_note: {
    intro:
      'You are in the behavior_note phase. Emit BOTH evidence records below in this single turn:',
    items: [
      {
        required: 'always',
        example:
          '{ "kind": "behavior_note", "summary": "<one-line summary>", "facts": { "content": "<the normalized, testable behavior the PBC will capture>" } }',
      },
      {
        required: 'always',
        example:
          '{ "kind": "pre_interview_analysis", "summary": "<one-line summary>", "facts": { "clarification_needed": false } }  // set clarification_needed:true ONLY if you genuinely cannot draft a PBC without a product_owner decision',
      },
    ],
  },
  pbc_draft: {
    intro: 'You are in the pbc_draft phase. Emit this evidence record in this single turn:',
    items: [
      {
        required: 'always',
        example:
          '{ "kind": "pbc_draft", "summary": "<one-line summary>", "facts": { "content": "<the full PBC draft text>", "iteration": 1 }, "data": { "basedOnBehaviorNoteId": "<id of the behavior_note evidence shown under \'Evidence already on this task\'>" } }',
      },
    ],
  },
  pressure: {
    intro:
      'You are in the pressure phase. Emit pressure_pass (always), and ALSO pbc_final when (and only when) the verdict is "ready", in this single turn:',
    items: [
      {
        required: 'always',
        example:
          '{ "kind": "pressure_pass", "summary": "<one-line summary>", "facts": { "verdict": "ready" | "needs_patch" | "too_vague" }, "data": { "reviewedDraftEvidenceId": "<id of the pbc_draft you reviewed, from \'Evidence already on this task\'>" } }',
      },
      {
        required: 'conditional',
        when: 'verdict is "ready"',
        example:
          '{ "kind": "pbc_final", "summary": "<one-line summary>", "facts": { "content": "<the finalized PBC>" }, "data": { "basedOnDraftEvidenceId": "<the same pbc_draft id>" } }',
      },
    ],
  },
}

/**
 * The exact participant output contract, embedded verbatim in the prompt so the
 * participant returns a parseable ParticipantOutput (SPEC §4.8).
 */
export const PARTICIPANT_OUTPUT_SCHEMA = `interface ParticipantOutput {
  evidence: Array<{
    kind: string;            // e.g. behavior_note, pressure_pass, pbc_final
    ref?: string;            // optional external reference
    summary?: string;        // short human summary of this evidence
    facts?: Record<string, unknown>; // structured facts required by the kind
    data?: unknown;          // optional runtime/run identity payload
  }>;
  satisfyObligations?: Array<{
    obligationId?: string;   // explicit obligation id to satisfy, if known
    obligationKind?: string; // otherwise match an open obligation by kind
    evidenceIndex: number;   // index into evidence[] that satisfies it
    reason?: string;
  }>;
  proposedTransition?: string; // a transition you RECOMMEND (harness decides)
  summary?: string;            // overall summary of this turn
}`

export function compilePbcPrompt(input: PromptCompileInput): string {
  const sections: string[] = []
  const state = input.next.instance.state

  // --- header ---------------------------------------------------------------
  sections.push(
    [
      '# PBC participant turn',
      '',
      `Task: ${input.task}`,
      `Role: ${input.role}`,
      `Actor: ${input.actor}`,
      `Workflow state: ${state.status}/${state.phase}`,
    ].join('\n')
  )

  // --- phase guidance (template-driven, selected by status+phase) -----------
  const phase = getPhaseGuidance(input.template, state)
  if (phase !== undefined) {
    const lines: string[] = ['## Current phase guidance', '', phase.agentInstruction]
    if (phase.expectedEvidence.length > 0) {
      lines.push(
        '',
        'Expected evidence — produce EVERY one of these evidence kinds in this single turn',
        '(the workflow cannot advance until all are present):'
      )
      for (const item of phase.expectedEvidence) {
        lines.push(`- ${item}`)
      }
    }
    if (phase.blockedBy.length > 0) {
      lines.push('', 'Blocked by:')
      for (const item of phase.blockedBy) {
        lines.push(`- ${item}`)
      }
    }
    if (phase.avoid.length > 0) {
      lines.push('', 'Avoid:')
      for (const item of phase.avoid) {
        lines.push(`- ${item}`)
      }
    }
    sections.push(lines.join('\n'))
  }

  // --- exact per-phase required evidence (completeness contract) -------------
  // Embed the precise evidence records the participant must emit this turn so a
  // general agent produces complete, valid output (T-03595). Only for the
  // worker-driven participant roles — product_owner /input is human and handled
  // separately.
  const phaseEvidence = PER_PHASE_EVIDENCE[state.phase]
  if (phaseEvidence !== undefined && AGENT_PARTICIPANT_ROLES.includes(input.role)) {
    const lines: string[] = [
      '## Required evidence for this phase — emit EVERY applicable item in THIS ONE turn',
      '',
      phaseEvidence.intro,
      '',
    ]
    for (const item of phaseEvidence.items) {
      const tag =
        item.required === 'conditional' && item.when !== undefined
          ? ` (ONLY when ${item.when})`
          : ' (required)'
      lines.push(`-${tag}`, '```json', item.example, '```')
    }
    lines.push(
      '',
      'Copy any `data` linkage ids verbatim from the "Evidence already on this task" section below — do not invent ids. The workflow cannot advance until every required evidence record above is present.'
    )
    sections.push(lines.join('\n'))
  }

  // --- role hard rules ------------------------------------------------------
  const role = input.template.roles[input.role]
  if (role !== undefined) {
    const lines: string[] = ['## Hard rules for your role']
    if (role.purpose !== undefined) {
      lines.push('', `Purpose: ${role.purpose}`)
    }
    lines.push('')
    for (const rule of role.hardRules) {
      lines.push(`- ${rule}`)
    }
    sections.push(lines.join('\n'))
  }

  // --- candidate transition guidance ----------------------------------------
  const candidates = input.next.actions
    .map((action) => action.transition)
    .filter((transition): transition is string => transition !== undefined)
  if (candidates.length > 0) {
    const lines: string[] = ['## Candidate next actions', '']
    for (const transition of candidates) {
      lines.push(`### ${transition}`)
      const guidance = getTransitionGuidance(input.template, transition)
      if (guidance !== undefined) {
        lines.push(guidance.prompt)
        if (guidance.produceEvidence.length > 0) {
          lines.push(`Evidence to produce: ${guidance.produceEvidence.join(', ')}`)
        }
        if (guidance.satisfyObligations.length > 0) {
          lines.push(`Obligations to satisfy: ${guidance.satisfyObligations.join(', ')}`)
        }
        if (guidance.operatorHint !== undefined) {
          lines.push(`Operator hint: ${guidance.operatorHint}`)
        }
      }
      lines.push('')
    }
    sections.push(lines.join('\n').trimEnd())
  }

  // --- blocked transitions --------------------------------------------------
  if (input.next.blockedTransitions.length > 0) {
    const lines: string[] = ['## Blocked transitions', '']
    for (const blocked of input.next.blockedTransitions) {
      const name = blocked.transition ?? blocked.id ?? '(unknown)'
      const reason = blocked.reason !== undefined ? ` — ${blocked.reason}` : ''
      lines.push(`- ${name}${reason}`)
    }
    sections.push(lines.join('\n'))
  }

  // --- open obligations + required evidence kinds ---------------------------
  if (input.obligations.length > 0) {
    const lines: string[] = ['## Open obligations', '']
    for (const obligation of input.obligations) {
      lines.push(
        `- ${obligation.kind} (id: ${obligation.id}, status: ${obligation.status}) — requires ${obligation.kind} evidence`
      )
    }
    sections.push(lines.join('\n'))
  }

  // --- existing evidence summaries (context) --------------------------------
  if (input.evidenceSummaries.length > 0) {
    const lines: string[] = ['## Evidence already on this task', '']
    for (const evidence of input.evidenceSummaries) {
      const summary = evidence.summary !== undefined ? ` — ${evidence.summary}` : ''
      // Surface the evidence id so the participant can copy it into the `data`
      // linkage fields (reviewedDraftEvidenceId, basedOnDraftEvidenceId, …).
      lines.push(`- ${evidence.kind} (id: ${evidence.id})${summary}`)
    }
    sections.push(lines.join('\n'))
  }

  // --- participant output schema --------------------------------------------
  sections.push(
    [
      '## Required output format',
      '',
      'Return a single ParticipantOutput JSON object matching this schema exactly:',
      '',
      '```ts',
      PARTICIPANT_OUTPUT_SCHEMA,
      '```',
    ].join('\n')
  )

  // --- system-level guardrails ----------------------------------------------
  const isAgentParticipant = AGENT_PARTICIPANT_ROLES.includes(input.role)
  const obligationGuardrail = isAgentParticipant
    ? '- EVIDENCE ONLY: you are an agent participant. OMIT `satisfyObligations` entirely (return evidence only). Obligation satisfaction is reserved for human product_owner /input — never emit a `satisfyObligations` directive for evidence you produced.'
    : '- Only set `satisfyObligations` for obligations explicitly listed under "## Open obligations" above. If there are no open obligations, OMIT `satisfyObligations` entirely — do not invent an obligation for evidence you just produced.'
  sections.push(
    [
      '## Guardrails',
      '',
      '- Do not call wrkf directly. You produce evidence and recommendations; the harness writes them to wrkf.',
      '- Do not apply transitions yourself. The harness applies transitions after validating your output.',
      '- All evidence must be grounded in the actual task context — do not invent facts.',
      '- You must NOT fabricate or synthesize product_owner obligation evidence (e.g. clarification_response, patch_decision). Only a product_owner actor may produce it.',
      obligationGuardrail,
      '- Evidence `facts` MUST be flat: each value is a scalar (string/number/boolean/null) or an array of scalars. Do NOT nest objects or arrays inside a fact value.',
    ].join('\n')
  )

  return sections.join('\n\n')
}

export { PRODUCT_OWNER_EVIDENCE_KINDS }
