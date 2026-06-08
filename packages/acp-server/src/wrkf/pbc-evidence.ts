/**
 * PBC harness Phase 3 — evidence ingestion + obligation satisfaction.
 *
 * SPEC §4.9 / §4.10:
 *   1. Validate participant-produced facts against the PBC template (best-effort).
 *   2. For each evidence record call wrkf.evidence.add forwarding actor/role/data.
 *   3. Satisfy claimed obligations: obligation.list -> match by id or kind+blocking
 *      -> obligation.satisfy({ task, id, evidenceId }).
 *   4. RE-READ `next` after all evidence/obligation writes and BEFORE any
 *      transition — every write rotates the instance contextHash, so a stale
 *      `next` would fail the CAS check on transition.apply (locked invariant).
 *
 * Locked constraints:
 *   - evidence.add MUST forward actor, role, and data.
 *   - `next` is re-read with the task only (no actor — wrkf.next does not accept one).
 *   - the agent role MUST NOT synthesize product_owner obligation evidence unless
 *     allowProductOwnerSimulation is explicitly enabled.
 */

import {
  projectEvidenceRecord,
  projectNextActionResponse,
  projectObligationRecord,
  type EvidenceRecord,
  type NextActionResponse,
  type ObligationRecord,
} from './projections.js'
import { PRODUCT_OWNER_EVIDENCE_KINDS } from './pbc-prompt-compiler.js'

// ---------------------------------------------------------------------------
// Participant output contract (mirrors the schema embedded by the compiler)
// ---------------------------------------------------------------------------

export interface ParticipantOutputEvidence {
  kind: string
  ref?: string
  summary?: string
  facts?: Record<string, unknown>
  data?: unknown
}

export interface SatisfyObligationDirective {
  obligationId?: string
  obligationKind?: string
  evidenceIndex: number
  reason?: string
}

export interface ParticipantOutput {
  evidence: ParticipantOutputEvidence[]
  satisfyObligations?: SatisfyObligationDirective[]
  proposedTransition?: string
  summary?: string
}

// ---------------------------------------------------------------------------
// Port (subset of the wrkf client used by ingestion). Kept structural so a
// fake spy port can satisfy it in tests.
// ---------------------------------------------------------------------------

export interface PbcEvidencePort {
  next(params: { task: string; role?: string }): Promise<unknown>
  evidence: {
    add(params: {
      task: string
      kind: string
      ref?: string
      summary?: string
      facts?: Record<string, unknown>
      data?: unknown
      actor?: string
      role?: string
    }): Promise<unknown>
  }
  obligation: {
    list(params: { task: string }): Promise<unknown[]>
    satisfy(params: { task: string; id: string; evidenceId?: string }): Promise<unknown>
  }
}

export interface EvidenceIngestionInput {
  task: string
  role: string
  actor: string
  allowProductOwnerSimulation?: boolean
  participantOutput: ParticipantOutput
}

export interface EvidenceIngestionResult {
  evidenceAdded: EvidenceRecord[]
  obligationsSatisfied: ObligationRecord[]
  next: NextActionResponse
}

// ---------------------------------------------------------------------------
// Fact validation (SPEC §4.9 required facts)
// ---------------------------------------------------------------------------

const PRESSURE_VERDICTS = ['ready', 'needs_patch', 'too_vague']
const PATCH_ROUTES = ['finalize', 'revise']
const DISPOSITION_RESOLUTIONS = ['wont_fix', 'duplicate', 'unclear', 'out_of_scope']

/**
 * Validate participant-produced evidence facts against the known PBC evidence
 * kinds. Throws on the first invalid record. wrkf remains authoritative and may
 * still reject; this is a best-effort pre-flight check.
 */
export function validateParticipantOutputFacts(output: ParticipantOutput): void {
  for (const evidence of output.evidence) {
    const facts = evidence.facts
    switch (evidence.kind) {
      case 'pre_interview_analysis': {
        if (facts !== undefined && 'clarification_needed' in facts) {
          if (typeof facts['clarification_needed'] !== 'boolean') {
            throw new Error(
              'pre_interview_analysis.facts.clarification_needed must be a boolean'
            )
          }
        }
        break
      }
      case 'pressure_pass': {
        const verdict = facts?.['verdict']
        if (typeof verdict !== 'string' || !PRESSURE_VERDICTS.includes(verdict)) {
          throw new Error(
            `pressure_pass.facts.verdict must be one of: ${PRESSURE_VERDICTS.join(', ')}`
          )
        }
        break
      }
      case 'patch_decision': {
        const route = facts?.['route']
        if (typeof route !== 'string' || !PATCH_ROUTES.includes(route)) {
          throw new Error(
            `patch_decision.facts.route must be one of: ${PATCH_ROUTES.join(', ')}`
          )
        }
        break
      }
      case 'disposition_decision': {
        const resolution = facts?.['resolution']
        if (typeof resolution !== 'string' || !DISPOSITION_RESOLUTIONS.includes(resolution)) {
          throw new Error(
            `disposition_decision.facts.resolution must be one of: ${DISPOSITION_RESOLUTIONS.join(', ')}`
          )
        }
        break
      }
      default:
        // Other kinds carry no required facts.
        break
    }
  }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export async function ingestEvidenceAndSatisfyObligations(
  port: PbcEvidencePort,
  input: EvidenceIngestionInput
): Promise<EvidenceIngestionResult> {
  const output = input.participantOutput

  // 1. Product-owner fabrication gate (before any write).
  if (input.role === 'agent' && input.allowProductOwnerSimulation !== true) {
    const offending = output.evidence.find((e) => PRODUCT_OWNER_EVIDENCE_KINDS.includes(e.kind))
    if (offending !== undefined) {
      throw new Error(
        `Agent role must not synthesize product_owner obligation evidence ` +
          `(kind "${offending.kind}") unless allowProductOwnerSimulation is enabled.`
      )
    }
  }

  // 2. Best-effort fact validation before sending anything to wrkf.
  validateParticipantOutputFacts(output)

  // 3. Add every evidence record, forwarding actor/role/data.
  const evidenceAdded: EvidenceRecord[] = []
  for (const evidence of output.evidence) {
    const added = await port.evidence.add({
      task: input.task,
      kind: evidence.kind,
      ...(evidence.ref !== undefined ? { ref: evidence.ref } : {}),
      ...(evidence.summary !== undefined ? { summary: evidence.summary } : {}),
      ...(evidence.facts !== undefined ? { facts: evidence.facts } : {}),
      ...(evidence.data !== undefined ? { data: evidence.data } : {}),
      actor: input.actor,
      role: input.role,
    })
    evidenceAdded.push(projectEvidenceRecord(added))
  }

  // 4. Satisfy claimed obligations (list -> match -> satisfy).
  const obligationsSatisfied: ObligationRecord[] = []
  const directives = output.satisfyObligations ?? []
  if (directives.length > 0) {
    const openRaw = await port.obligation.list({ task: input.task })
    const open = openRaw.map((entry) => projectObligationRecord(entry))

    for (const directive of directives) {
      const id = resolveObligationId(directive, open)
      const evidenceId = evidenceAdded[directive.evidenceIndex]?.id
      const satisfied = await port.obligation.satisfy({
        task: input.task,
        id,
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      })
      obligationsSatisfied.push(projectObligationRecord(satisfied))
    }
  }

  // 5. Re-read `next` AFTER all writes and BEFORE any transition.
  //    Task only — wrkf.next does not accept an actor.
  const freshRaw = await port.next({ task: input.task })
  const next = projectNextActionResponse(freshRaw)

  return { evidenceAdded, obligationsSatisfied, next }
}

function resolveObligationId(
  directive: SatisfyObligationDirective,
  open: ObligationRecord[]
): string {
  if (directive.obligationId !== undefined) {
    return directive.obligationId
  }
  if (directive.obligationKind !== undefined) {
    const match = open.find(
      (o) => o.kind === directive.obligationKind && o.status === 'open'
    )
    if (match === undefined) {
      throw new Error(
        `no open obligation matching kind "${directive.obligationKind}" to satisfy`
      )
    }
    return match.id
  }
  throw new Error('satisfyObligations entry requires obligationId or obligationKind')
}
