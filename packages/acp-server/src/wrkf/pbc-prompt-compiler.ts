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
} from './pbc-template-model.js'
import type { EvidenceRecord, NextActionResponse, ObligationRecord } from './projections.js'

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

/**
 * The exact participant output contract, embedded verbatim in the prompt so the
 * participant returns a parseable ParticipantOutput (SPEC §4.8).
 */
const PARTICIPANT_OUTPUT_SCHEMA = `interface ParticipantOutput {
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
      lines.push('', 'Expected evidence:')
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
      lines.push(`- ${evidence.kind}${summary}`)
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
  sections.push(
    [
      '## Guardrails',
      '',
      '- Do not call wrkf directly. You produce evidence and recommendations; the harness writes them to wrkf.',
      '- Do not apply transitions yourself. The harness applies transitions after validating your output.',
      '- All evidence must be grounded in the actual task context — do not invent facts.',
      '- You must NOT fabricate or synthesize product_owner obligation evidence (e.g. clarification_response, patch_decision). Only a product_owner actor may produce it.',
    ].join('\n')
  )

  return sections.join('\n\n')
}

export { PRODUCT_OWNER_EVIDENCE_KINDS }
