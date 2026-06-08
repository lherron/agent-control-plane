/**
 * Generic participant-output capture / replay mechanics — pack-agnostic.
 *
 * The capture/replay dance is purely structural:
 *
 *   'launched-runtime' — a runtime run is still in-flight; there is no output yet.
 *                        Returns 'awaiting_runtime_output' immediately with ZERO
 *                        writes and NO captures.set.
 *
 *   'supplied'         — the caller already has the participant's output. Ingestion
 *                        is delegated to the injected `ingest` thunk and the result
 *                        is recorded in the captures store keyed by captureKey.
 *
 * Locked invariants:
 *   - This module NEVER applies transitions and names no pack-specific concept.
 *   - Ingestion is idempotent: captures.get is consulted before invoking `ingest`,
 *     and a successful ingest records into captures.set so a replay with the same
 *     captureKey returns 'already_captured' without re-running ingestion.
 */

import type { EvidenceRecord, NextActionResponse, ObligationRecord } from '../projections.js'
import type { EvidenceWriterPort } from './evidence-writer.js'

// ---------------------------------------------------------------------------
// Capture record (idempotency store value)
// ---------------------------------------------------------------------------

export interface CaptureRecord {
  status: 'ingested'
  evidenceAdded: EvidenceRecord[]
  obligationsSatisfied: ObligationRecord[]
}

// ---------------------------------------------------------------------------
// Port — an evidence writer port PLUS the captures idempotency namespace.
// DELIBERATELY excludes transition.apply.
// ---------------------------------------------------------------------------

export interface CapturePort extends EvidenceWriterPort {
  captures: {
    get(captureKey: string): Promise<CaptureRecord | undefined>
    set(captureKey: string, record: CaptureRecord): Promise<void>
  }
}

export type CaptureMode = 'supplied' | 'launched-runtime'

export interface CaptureIngestResult {
  status: 'ingested' | 'already_captured' | 'awaiting_runtime_output'
  captureKey: string
  evidenceAdded: EvidenceRecord[]
  obligationsSatisfied: ObligationRecord[]
  next?: NextActionResponse
}

/** Result shape the injected ingest thunk must return. */
export interface CaptureIngest {
  evidenceAdded: EvidenceRecord[]
  obligationsSatisfied: ObligationRecord[]
  next: NextActionResponse
}

// ---------------------------------------------------------------------------
// Capture + ingest (generic)
// ---------------------------------------------------------------------------

export async function captureAndIngest(
  port: CapturePort,
  params: {
    captureKey: string
    mode: CaptureMode
    /** Invoked only in 'supplied' mode, AFTER the idempotency check passes. */
    ingest: () => Promise<CaptureIngest>
  }
): Promise<CaptureIngestResult> {
  // ── launched-runtime: nothing to ingest yet. Zero writes, no capture. ──────
  if (params.mode === 'launched-runtime') {
    return {
      status: 'awaiting_runtime_output',
      captureKey: params.captureKey,
      evidenceAdded: [],
      obligationsSatisfied: [],
    }
  }

  // ── Idempotency: check the captures store BEFORE any write. ────────────────
  const existing = await port.captures.get(params.captureKey)
  if (existing !== undefined) {
    return {
      status: 'already_captured',
      captureKey: params.captureKey,
      evidenceAdded: existing.evidenceAdded,
      obligationsSatisfied: existing.obligationsSatisfied,
    }
  }

  // ── Delegate ingestion to the injected thunk. ─────────────────────────────
  const ingest = await params.ingest()

  // ── Record the capture for replay idempotency. ────────────────────────────
  const record: CaptureRecord = {
    status: 'ingested',
    evidenceAdded: ingest.evidenceAdded,
    obligationsSatisfied: ingest.obligationsSatisfied,
  }
  await port.captures.set(params.captureKey, record)

  return {
    status: 'ingested',
    captureKey: params.captureKey,
    evidenceAdded: ingest.evidenceAdded,
    obligationsSatisfied: ingest.obligationsSatisfied,
    next: ingest.next,
  }
}
