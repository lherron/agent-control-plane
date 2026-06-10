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
      'You are in the behavior_note phase. Record BOTH evidence records below this turn (one `wrkf evidence add` per record):',
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
    intro: 'You are in the pbc_draft phase. Record this evidence record this turn (via `wrkf evidence add`):',
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
      'You are in the pressure phase. Record pressure_pass (always), and ALSO pbc_final when (and only when) the verdict is "ready", this turn (one `wrkf evidence add` per record):',
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
          '{ "kind": "pbc_final", "summary": "<one-line summary>", "facts": { "content": "<the finalized PBC>" }, "data": { "basedOnDraftEvidenceId": "<the same pbc_draft id>", "basedOnPressurePassEvidenceId": "<the pressure_pass id you just recorded>" } }',
      },
    ],
  },
}

/**
 * Per-phase prior-evidence kinds whose CONTENT (not just kind+id) the participant
 * needs to write grounded PBC evidence this turn (T-03678). intake_metadata is
 * always surfaced separately as "Raw product feedback"; the kinds listed here are
 * the additional prior evidence whose content must appear in the CONTEXT section:
 *   - pbc_draft  → grounded in the behavior_note + pre_interview_analysis + clarification_response.
 *   - pressure   → reviews the actual pbc_draft text.
 */
const PHASE_CONTEXT_KINDS: Record<string, string[]> = {
  behavior_note: [],
  pbc_draft: ['behavior_note', 'pre_interview_analysis', 'clarification_response'],
  pressure: ['behavior_note', 'pbc_draft'],
}

/** Render a fact/data value verbatim for embedding in the prompt CONTEXT. */
function stringifyContentValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) {
    return String(value)
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

/**
 * Extract the task's raw product feedback from the intake_metadata evidence
 * (facts.rawFeedback, falling back to data.rawFeedback). Returns undefined when
 * no intake_metadata evidence carries a rawFeedback string.
 */
function extractRawFeedback(evidence: EvidenceRecord[]): string | undefined {
  for (const record of evidence) {
    if (record.kind !== 'intake_metadata') {
      continue
    }
    const fromFacts = record.facts?.['rawFeedback']
    if (typeof fromFacts === 'string' && fromFacts.length > 0) {
      return fromFacts
    }
    const data = record.data
    if (data !== null && typeof data === 'object') {
      const fromData = (data as Record<string, unknown>)['rawFeedback']
      if (typeof fromData === 'string' && fromData.length > 0) {
        return fromData
      }
    }
  }
  return undefined
}

/**
 * Render the substantive content (facts + data fields) of a prior evidence
 * record so the participant can ground its output in the actual text — not just
 * the kind+id summary (T-03678).
 */
function extractContentLines(record: EvidenceRecord): string[] {
  const lines: string[] = []
  if (record.facts !== undefined) {
    for (const [key, value] of Object.entries(record.facts)) {
      lines.push(`- ${key}: ${stringifyContentValue(value)}`)
    }
  }
  const data = record.data
  if (data !== null && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      lines.push(`- ${key}: ${stringifyContentValue(value)}`)
    }
  }
  return lines
}

/**
 * Build the "## Context — product feedback & prior evidence content" section
 * (T-03678/T-03755). Surfaces the SUBSTANTIVE content the participant needs to
 * write grounded PBC evidence this turn — the task's raw product feedback plus
 * the content (not just kind+id) of prior evidence relevant to the current
 * phase. Shared by BOTH the template path (compilePbcPrompt) AND the
 * compileWorkerPrompt fallback path so the agent is never content-blind
 * regardless of template availability. Returns undefined when there is no
 * context to surface.
 */
export function buildPbcContextSection(
  phase: string,
  evidence: EvidenceRecord[]
): string | undefined {
  const contextLines: string[] = []

  const rawFeedback = extractRawFeedback(evidence)
  if (rawFeedback !== undefined) {
    contextLines.push('### Raw product feedback', '', rawFeedback)
  }

  const relevantKinds = PHASE_CONTEXT_KINDS[phase]
  const relevant = evidence.filter(
    (record) =>
      record.kind !== 'intake_metadata' &&
      (relevantKinds === undefined || relevantKinds.includes(record.kind))
  )
  if (relevant.length > 0) {
    if (contextLines.length > 0) {
      contextLines.push('')
    }
    contextLines.push('### Prior evidence content')
    for (const record of relevant) {
      const body = extractContentLines(record)
      contextLines.push('', `#### ${record.kind} (id: ${record.id})`)
      if (body.length > 0) {
        contextLines.push(...body)
      }
    }
  }

  if (contextLines.length === 0) {
    return undefined
  }

  return [
    '## Context — product feedback & prior evidence content',
    '',
    'Ground your evidence in the content below. This is the actual product',
    'feedback and the relevant prior evidence for this phase — write about',
    'THIS, do not describe the prompt or invent facts.',
    '',
    ...contextLines,
  ].join('\n')
}

/**
 * The exact participant output contract, retained for the human /input path
 * (mapPbcHumanInput) and any consumer that still parses free-text
 * ParticipantOutput. The autonomous participant no longer emits this — it records
 * evidence by calling `wrkf evidence add` directly (see WRKF_EVIDENCE_LOOP).
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

/**
 * The standing instructions that tell the autonomous participant to record its
 * evidence by calling the `wrkf` CLI directly during this turn, and to
 * self-correct against the engine's validation errors before ending the turn.
 * Replaces the old "emit exactly one JSON object" contract. `wrkf` already runs
 * the template validators at add time and returns precise, fixable errors; the
 * worker (not the participant) applies transitions afterward.
 *
 * The participant's actor/role are pinned by the launching worker (trusted
 * binding) — it MUST NOT pass --actor/--role.
 */
export function buildWrkfEvidenceLoop(task: string): string {
  return [
    '## How to record your evidence — call `wrkf` directly',
    '',
    'You record evidence by running the `wrkf` CLI in this turn. The engine',
    'validates each record AT ADD TIME and returns a precise error if it is wrong;',
    'read the error, fix the command, and re-run it. Do NOT end your turn until the',
    'phase is satisfied. The worker applies the transition afterward — you do not.',
    '',
    '1. See exactly what is required (and why):',
    '   ```',
    `   wrkf next ${task} --json`,
    '   ```',
    '   Read `actions[].why` and `blockedTransitions[].blocksOn[]` — they name the',
    '   evidence kind(s) still missing for this phase.',
    '',
    '2. Look up the exact contract for each kind (required facts, enums, linkage',
    '   refs) and the live linkage ids you must reference (do NOT invent ids):',
    '   ```',
    `   wrkf evidence schema ${task} --kind <kind> --json`,
    `   wrkf evidence list ${task} --json`,
    '   ```',
    '',
    '3. Record EACH required evidence record (see the per-phase list below). Always',
    '   pass `--json` so errors come back structured:',
    '   ```',
    `   wrkf evidence add ${task} --kind <kind> --ref pbc --json \\`,
    "     --summary '<one-line summary>' \\",
    "     --facts '<facts JSON>' --data '<data JSON>'",
    '   ```',
    '   - `--facts` / `--data` take a single JSON object (omit `--data` when the',
    '     record has none). `facts` values must be flat scalars or arrays of scalars.',
    '   - On failure `wrkf` exits nonzero and prints `{"error":{code,field,message,',
    '     expected,allowed,fix}}` on stdout. READ the `fix`/`expected`/`allowed`',
    '     fields, correct the command, and run it again. Iterating until accepted is',
    '     expected — do NOT give up after one rejection.',
    '',
    '4. Confirm the phase is complete before ending your turn:',
    '   ```',
    `   wrkf next ${task} --json`,
    '   ```',
    '   The phase is done when no blocker references an evidence kind you produce.',
    '',
    'Do NOT pass `--actor` or `--role` — your identity is set for you.',
    'Do NOT run `wrkf transition` — the worker decides and applies transitions.',
  ].join('\n')
}

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

  // --- CONTEXT: product feedback + relevant prior-evidence content ----------
  // Surface the SUBSTANTIVE content the participant needs to write grounded PBC
  // evidence this turn — the task's raw product feedback plus the content (not
  // just kind+id) of prior evidence relevant to the current phase (T-03678).
  // Without this the agent writes content-blind output about the prompt contract
  // itself rather than about the actual feedback (e.g. "dark mode toggle").
  {
    const contextSection = buildPbcContextSection(state.phase, input.evidenceSummaries)
    if (contextSection !== undefined) {
      sections.push(contextSection)
    }
  }

  // --- exact per-phase required evidence (completeness contract) -------------
  // Embed the precise evidence records the participant must emit this turn so a
  // general agent produces complete, valid output (T-03595). Only for the
  // worker-driven participant roles — product_owner /input is human and handled
  // separately.
  const phaseEvidence = PER_PHASE_EVIDENCE[state.phase]
  if (phaseEvidence !== undefined && AGENT_PARTICIPANT_ROLES.includes(input.role)) {
    const lines: string[] = [
      '## Required evidence for this phase — record EVERY applicable item in THIS ONE turn',
      '',
      phaseEvidence.intro,
      '',
      'Each record below is the SHAPE to pass to `wrkf evidence add` (its `kind`,',
      '`facts`, and `data`). Add one record per command.',
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
      'Copy any `data` linkage ids verbatim from `wrkf evidence list` / the "Evidence already on this task" section below — do not invent ids. The workflow cannot advance until every required evidence record above is present.'
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

  // --- how to record evidence: the wrkf loop --------------------------------
  sections.push(buildWrkfEvidenceLoop(input.task))

  // --- system-level guardrails ----------------------------------------------
  sections.push(
    [
      '## Guardrails',
      '',
      '- Record evidence ONLY via `wrkf evidence add`. Do not apply transitions — `wrkf transition` is the worker\'s job.',
      '- All evidence must be grounded in the actual task context — do not invent facts.',
      '- You must NOT add product_owner evidence (e.g. clarification_response, patch_decision). Only a product_owner actor may produce it; the engine will reject it from you.',
      '- Evidence `facts` MUST be flat: each value is a scalar (string/number/boolean/null) or an array of scalars. Do NOT nest objects or arrays inside a fact value.',
      '- Do not pass `--actor` or `--role`; your identity is bound for you.',
    ].join('\n')
  )

  return sections.join('\n\n')
}

export { PRODUCT_OWNER_EVIDENCE_KINDS }
