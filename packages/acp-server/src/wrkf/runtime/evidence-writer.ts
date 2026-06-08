/**
 * Generic evidence writer — pack-agnostic write path for participant output.
 *
 * Mechanics only (no pack-specific knowledge):
 *   1. Run the injected pack policy's pre-flight validation (if any) BEFORE any
 *      write. The policy may reject the output (e.g. an actor/role that may not
 *      submit a given kind); the writer itself names no evidence kind.
 *   2. For each evidence record call `evidence.add`, forwarding actor/role/data.
 *   3. Satisfy claimed obligations: `obligation.list` -> match by explicit id, or
 *      by kind ONLY when the pack policy permits kind lookup ->
 *      `obligation.satisfy({ task, id, evidenceId })`.
 *   4. RE-READ `next` AFTER all evidence/obligation writes and BEFORE any
 *      transition — every write rotates the instance contextHash, so a stale
 *      `next` would fail the CAS check on transition.apply (locked invariant).
 *
 * Locked constraints:
 *   - evidence.add MUST forward actor, role, and data.
 *   - `next` is re-read with the task only (no actor — wrkf.next does not accept one).
 *   - This module is pack-FREE: all kind/role policy is injected via EvidenceWritePolicy.
 */

import {
  type EvidenceRecord,
  type NextActionResponse,
  type ObligationRecord,
  projectEvidenceRecord,
  projectNextActionResponse,
  projectObligationRecord,
} from '../projections.js'

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
// Port (subset of the wrkf client used by the write path). Kept structural so a
// fake spy port can satisfy it in tests.
// ---------------------------------------------------------------------------

export interface EvidenceWriterPort {
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
    satisfy(params: {
      task: string
      id: string
      evidenceId?: string
      /** Forwarded to wrkf — wrkf enforces ownerRole on obligation.satisfy. */
      role?: string
      actor?: string
    }): Promise<unknown>
  }
}

export interface EvidenceWriteInput {
  task: string
  role: string
  actor: string
  participantOutput: ParticipantOutput
}

export interface EvidenceWriteResult {
  evidenceAdded: EvidenceRecord[]
  obligationsSatisfied: ObligationRecord[]
  next: NextActionResponse
}

/**
 * Pack-supplied policy injected into the generic writer. The writer names no
 * evidence kind itself; all kind/role/facts policy lives behind these hooks.
 */
export interface EvidenceWritePolicy {
  /**
   * Pre-flight validation run BEFORE any write. Throw to reject the output
   * (e.g. an actor/role that may not submit a given kind, or invalid facts).
   */
  validate?(output: ParticipantOutput, ctx: { role: string; actor: string }): void
  /**
   * Whether obligations may be satisfied by kind lookup (obligationKind) when no
   * explicit obligationId is supplied. Defaults to false — explicit id only.
   */
  allowObligationKindLookup?: boolean
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export async function writeEvidenceAndSatisfyObligations(
  port: EvidenceWriterPort,
  input: EvidenceWriteInput,
  policy: EvidenceWritePolicy = {}
): Promise<EvidenceWriteResult> {
  const output = input.participantOutput

  // 1. Pack policy pre-flight (rejection gate + facts validation). Before writes.
  policy.validate?.(output, { role: input.role, actor: input.actor })

  // 2. Add every evidence record, forwarding actor/role/data.
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

  // 3. Satisfy claimed obligations (list -> match -> satisfy).
  const obligationsSatisfied: ObligationRecord[] = []
  const directives = output.satisfyObligations ?? []
  if (directives.length > 0) {
    const openRaw = await port.obligation.list({ task: input.task })
    const open = openRaw.map((entry) => projectObligationRecord(entry))

    for (const directive of directives) {
      const id = resolveObligationId(directive, open, policy)
      const evidenceId = evidenceAdded[directive.evidenceIndex]?.id
      const satisfied = await port.obligation.satisfy({
        task: input.task,
        id,
        ...(evidenceId !== undefined ? { evidenceId } : {}),
        // wrkf enforces ownerRole on obligation.satisfy; forward the caller's role/actor.
        role: input.role,
        actor: input.actor,
      })
      obligationsSatisfied.push(projectObligationRecord(satisfied))
    }
  }

  // 4. Re-read `next` AFTER all writes and BEFORE any transition.
  //    Task only — wrkf.next does not accept an actor.
  const freshRaw = await port.next({ task: input.task })
  const next = projectNextActionResponse(freshRaw)

  return { evidenceAdded, obligationsSatisfied, next }
}

function resolveObligationId(
  directive: SatisfyObligationDirective,
  open: ObligationRecord[],
  policy: EvidenceWritePolicy
): string {
  if (directive.obligationId !== undefined) {
    return directive.obligationId
  }
  if (directive.obligationKind !== undefined) {
    if (policy.allowObligationKindLookup !== true) {
      throw new Error('obligation lookup by kind is not permitted by the active pack policy')
    }
    const match = open.find((o) => o.kind === directive.obligationKind && o.status === 'open')
    if (match === undefined) {
      throw new Error(`no open obligation matching kind "${directive.obligationKind}" to satisfy`)
    }
    return match.id
  }
  throw new Error('satisfyObligations entry requires obligationId or obligationKind')
}
