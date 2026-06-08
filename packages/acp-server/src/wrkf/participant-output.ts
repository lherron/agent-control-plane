/**
 * PBC harness Phase 4.5 — participant-output capture + ingestion contract.
 *
 * SPEC §4.8 (ParticipantOutput contract) / §4.15 (route idempotency key scheme).
 *
 * This module is the return channel for structured ParticipantOutput. It has two
 * modes:
 *
 *   'supplied'         — the caller already has the participant's output (offline
 *                        simulation, or an HRC run that has finished and delivered
 *                        its result). The output is ingested via the P3 evidence /
 *                        obligation loop (ingestEvidenceAndSatisfyObligations — NOT
 *                        re-implemented here) and the result is recorded in the
 *                        captures store keyed by captureKey for idempotency.
 *
 *   'launched-runtime' — an HRC run is still in-flight; there is no output yet.
 *                        Returns 'awaiting_runtime_output' immediately with ZERO
 *                        wrkf writes and NO captures.set. The caller (P5 autopilot)
 *                        polls / waits and re-invokes with mode='supplied' once the
 *                        runtime delivers structured output.
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
  ingestEvidenceAndSatisfyObligations,
  type ParticipantOutput,
  type PbcEvidencePort,
} from './pbc-evidence.js'
import type {
  EvidenceRecord,
  NextActionResponse,
  ObligationRecord,
} from './projections.js'

// ---------------------------------------------------------------------------
// Capture record (idempotency store value)
// ---------------------------------------------------------------------------

export interface CaptureRecord {
  status: 'ingested'
  evidenceAdded: EvidenceRecord[]
  obligationsSatisfied: ObligationRecord[]
}

// ---------------------------------------------------------------------------
// Port — PbcEvidencePort PLUS the captures idempotency namespace.
// DELIBERATELY excludes transition.apply.
// ---------------------------------------------------------------------------

export interface ParticipantOutputPort extends PbcEvidencePort {
  captures: {
    get(captureKey: string): Promise<CaptureRecord | undefined>
    set(captureKey: string, record: CaptureRecord): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// Input / output contract
// ---------------------------------------------------------------------------

export type ParticipantOutputMode = 'supplied' | 'launched-runtime'

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

export interface CaptureIngestResult {
  status: 'ingested' | 'already_captured' | 'awaiting_runtime_output'
  captureKey: string
  evidenceAdded: EvidenceRecord[]
  obligationsSatisfied: ObligationRecord[]
  next?: NextActionResponse
}

// ---------------------------------------------------------------------------
// Capture key scheme (SPEC §4.15) — P6 routes MUST use this before calling
// captureAndIngestParticipantOutput.
// ---------------------------------------------------------------------------

export function makeParticipantOutputCaptureKey(routeKey: string, task: string): string {
  return `${routeKey}:participant-output:${task}`
}

// ---------------------------------------------------------------------------
// Capture + ingest
// ---------------------------------------------------------------------------

export async function captureAndIngestParticipantOutput(
  port: ParticipantOutputPort,
  input: ParticipantOutputInput
): Promise<CaptureIngestResult> {
  // ── launched-runtime: nothing to ingest yet. Zero wrkf writes, no capture. ──
  if (input.mode === 'launched-runtime') {
    return {
      status: 'awaiting_runtime_output',
      captureKey: input.captureKey,
      evidenceAdded: [],
      obligationsSatisfied: [],
    }
  }

  // ── supplied: participantOutput is required. ──────────────────────────────
  const output = input.participantOutput
  if (output === undefined) {
    throw new Error(
      'participantOutput is required when mode is "supplied"'
    )
  }

  // ── Idempotency: check the captures store BEFORE any wrkf write. ───────────
  const existing = await port.captures.get(input.captureKey)
  if (existing !== undefined) {
    return {
      status: 'already_captured',
      captureKey: input.captureKey,
      evidenceAdded: existing.evidenceAdded,
      obligationsSatisfied: existing.obligationsSatisfied,
    }
  }

  // ── Delegate to the P3 evidence / obligation loop (NO re-implementation). ──
  const ingest = await ingestEvidenceAndSatisfyObligations(port, {
    task: input.task,
    role: input.role,
    actor: input.actor,
    ...(input.allowProductOwnerSimulation !== undefined
      ? { allowProductOwnerSimulation: input.allowProductOwnerSimulation }
      : {}),
    participantOutput: output,
  })

  // ── Record the capture for replay idempotency. ────────────────────────────
  const record: CaptureRecord = {
    status: 'ingested',
    evidenceAdded: ingest.evidenceAdded,
    obligationsSatisfied: ingest.obligationsSatisfied,
  }
  await port.captures.set(input.captureKey, record)

  return {
    status: 'ingested',
    captureKey: input.captureKey,
    evidenceAdded: ingest.evidenceAdded,
    obligationsSatisfied: ingest.obligationsSatisfied,
    next: ingest.next,
  }
}
