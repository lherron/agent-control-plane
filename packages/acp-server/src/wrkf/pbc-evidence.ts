/**
 * PBC harness Phase 3 — evidence ingestion + obligation satisfaction.
 *
 * This module is now a thin PBC composition layer: the generic write mechanics
 * live in `runtime/evidence-writer.ts` (pack-free) and the PBC kind/facts/role
 * policy lives in `packs/pbc/evidence-policy.ts`. This entry point wires the two
 * together and preserves the historical public surface (importers depend on the
 * symbols re-exported below).
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
 *     allowProductOwnerSimulation is explicitly enabled (enforced in the PBC pack).
 */

import { makePbcEvidencePolicy } from './packs/pbc/evidence-policy.js'
import type { EvidenceRecord, NextActionResponse, ObligationRecord } from './projections.js'
import {
  type EvidenceWriterPort,
  type ParticipantOutput,
  writeEvidenceAndSatisfyObligations,
} from './runtime/evidence-writer.js'

// ---------------------------------------------------------------------------
// Re-exported generic contract (kept on the historical pbc-evidence path).
// ---------------------------------------------------------------------------

export type {
  ParticipantOutput,
  ParticipantOutputEvidence,
  SatisfyObligationDirective,
} from './runtime/evidence-writer.js'

/** Subset of the wrkf client used by PBC ingestion. Structurally generic. */
export type PbcEvidencePort = EvidenceWriterPort

// Re-exported PBC policy (best-effort fact validation).
export { validateParticipantOutputFacts } from './packs/pbc/evidence-policy.js'

// ---------------------------------------------------------------------------
// PBC ingestion input / output
// ---------------------------------------------------------------------------

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
// Ingestion — compose the generic writer with the PBC policy.
// ---------------------------------------------------------------------------

export async function ingestEvidenceAndSatisfyObligations(
  port: PbcEvidencePort,
  input: EvidenceIngestionInput
): Promise<EvidenceIngestionResult> {
  const policy = makePbcEvidencePolicy({
    ...(input.allowProductOwnerSimulation !== undefined
      ? { allowProductOwnerSimulation: input.allowProductOwnerSimulation }
      : {}),
  })

  return writeEvidenceAndSatisfyObligations(
    port,
    {
      task: input.task,
      role: input.role,
      actor: input.actor,
      participantOutput: input.participantOutput,
    },
    policy
  )
}
