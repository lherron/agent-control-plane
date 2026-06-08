/**
 * PBC harness Phase 4.5 — participant-output capture + ingestion contract.
 *
 * SPEC §4.8 (ParticipantOutput contract) / §4.15 (route idempotency key scheme).
 *
 * This module is the PBC-flavored return channel for structured ParticipantOutput.
 * The generic capture/replay mechanics now live in
 * `runtime/participant-capture.ts` (pack-free); this layer injects the PBC
 * ingestion (ingestEvidenceAndSatisfyObligations) and preserves the historical
 * public surface (importers depend on the symbols re-exported below).
 *
 * Two modes:
 *
 *   'supplied'         — the caller already has the participant's output (offline
 *                        simulation, or an HRC run that has finished and delivered
 *                        its result). The output is ingested via the P3 evidence /
 *                        obligation loop and recorded in the captures store keyed
 *                        by captureKey for idempotency.
 *
 *   'launched-runtime' — an HRC run is still in-flight; there is no output yet.
 *                        Returns 'awaiting_runtime_output' immediately with ZERO
 *                        wrkf writes and NO captures.set.
 *
 * Locked invariants:
 *   - This module NEVER applies transitions. ParticipantOutputPort intentionally
 *     omits transition.apply — transitions belong to P5 autopilot. A
 *     proposedTransition in the output is a recommendation only and is ignored here.
 *   - Ingestion is idempotent: captures.get is consulted before any wrkf write, and
 *     a successful ingest records into captures.set so a replay with the same
 *     captureKey returns 'already_captured' without re-calling evidence.add /
 *     obligation.satisfy (wrkf does NOT dedup evidence).
 */

import {
  type CaptureMode,
  type CapturePort,
  captureAndIngest,
} from './runtime/participant-capture.js'
import { type ParticipantOutput, ingestEvidenceAndSatisfyObligations } from './pbc-evidence.js'

// ---------------------------------------------------------------------------
// Re-exported generic capture contract (kept on the historical path).
// ---------------------------------------------------------------------------

export type { CaptureIngestResult, CaptureRecord } from './runtime/participant-capture.js'

/** Port — PbcEvidencePort PLUS the captures idempotency namespace. */
export type ParticipantOutputPort = CapturePort

export type ParticipantOutputMode = CaptureMode

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface ParticipantOutputInput {
  task: string
  role: string
  actor: string
  captureKey: string
  mode: ParticipantOutputMode
  /** Required when mode === 'supplied'. */
  participantOutput?: ParticipantOutput
  allowProductOwnerSimulation?: boolean
}

// ---------------------------------------------------------------------------
// Capture key scheme (SPEC §4.15) — P6 routes MUST use this before calling
// captureAndIngestParticipantOutput.
// ---------------------------------------------------------------------------

export function makeParticipantOutputCaptureKey(routeKey: string, task: string): string {
  return `${routeKey}:participant-output:${task}`
}

// ---------------------------------------------------------------------------
// Capture + ingest — inject PBC ingestion into the generic capture mechanics.
// ---------------------------------------------------------------------------

export async function captureAndIngestParticipantOutput(
  port: ParticipantOutputPort,
  input: ParticipantOutputInput
) {
  // ── supplied: participantOutput is required. ──────────────────────────────
  if (input.mode === 'supplied' && input.participantOutput === undefined) {
    throw new Error('participantOutput is required when mode is "supplied"')
  }

  return captureAndIngest(port, {
    captureKey: input.captureKey,
    mode: input.mode,
    // Invoked only in 'supplied' mode, AFTER the idempotency check passes.
    ingest: () =>
      ingestEvidenceAndSatisfyObligations(port, {
        task: input.task,
        role: input.role,
        actor: input.actor,
        ...(input.allowProductOwnerSimulation !== undefined
          ? { allowProductOwnerSimulation: input.allowProductOwnerSimulation }
          : {}),
        participantOutput: input.participantOutput as ParticipantOutput,
      }),
  })
}
