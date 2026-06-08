/**
 * RED TEST — wrkf error code → HTTP status mapping (W1 acceptance gate)
 *
 * Why red: `packages/acp-server/src/wrkf/errors.ts` does not exist yet.
 * Bun will throw CannotFindModule at file load; all tests below will fail.
 *
 * What larry must create to turn this green:
 *   packages/acp-server/src/wrkf/errors.ts
 *   └─ export function wrkfErrorToHttpStatus(code: string): number
 *      Mapping per CANONICAL_WORKFLOW_REFACTOR.md §"wrkf Error Mapping"
 *
 * Spec table (reproduced here as the source of truth for this test):
 *   WRKF_NOT_FOUND              → 404
 *   WRKF_ROLE_DENIED            → 403
 *   WRKF_STALE_REVISION         → 409
 *   WRKF_CONTEXT_MISMATCH       → 409
 *   WRKF_IDEMPOTENCY_MISMATCH   → 409
 *   WRKF_LEASE_CONFLICT         → 409
 *   WRKF_TRANSITION_BLOCKED     → 422
 *   WRKF_VALIDATION             → 422
 *   WRKF_EFFECT_NOT_DELIVERABLE → 422
 *   WRKF_DB_MIGRATION_REQUIRED  → 503
 *   WRKF_INTERNAL               → 500
 *   WRKF_UNAVAILABLE (ACP-local)→ 503  ← NOT a wrkf domain code
 *   <unknown code>              → 500  ← safe default
 */

import { describe, expect, test } from 'bun:test'

// ── RED IMPORT ──────────────────────────────────────────────────────────────
// This module does not exist yet. Bun throws CannotFindModule on load → RED.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- wrkf/errors.ts does not exist yet (W1 deliverable)
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'
// ────────────────────────────────────────────────────────────────────────────

describe('wrkfErrorToHttpStatus — spec §"wrkf Error Mapping"', () => {
  // ── Domain error codes from the spec table ────────────────────────────────
  const SPEC_TABLE: Array<[code: string, expectedHttp: number]> = [
    ['WRKF_NOT_FOUND', 404],
    ['WRKF_ROLE_DENIED', 403],
    ['WRKF_STALE_REVISION', 409],
    ['WRKF_CONTEXT_MISMATCH', 409],
    ['WRKF_IDEMPOTENCY_MISMATCH', 409],
    ['WRKF_LEASE_CONFLICT', 409],
    ['WRKF_TRANSITION_BLOCKED', 422],
    ['WRKF_VALIDATION', 422],
    ['WRKF_EFFECT_NOT_DELIVERABLE', 422],
    ['WRKF_DB_MIGRATION_REQUIRED', 503],
    ['WRKF_INTERNAL', 500],
  ]

  for (const [code, httpStatus] of SPEC_TABLE) {
    test(`${code} → HTTP ${httpStatus}`, () => {
      expect(wrkfErrorToHttpStatus(code)).toBe(httpStatus)
    })
  }

  // ── ACP-local code (not a wrkf domain code) ───────────────────────────────
  test('WRKF_UNAVAILABLE → 503 (ACP-synthesized for transport / process-death failures)', () => {
    // WRKF_UNAVAILABLE is not emitted by the wrkf process.
    // ACP synthesizes it when: WrkfClient.spawn fails, the child process dies,
    // or a pending request is rejected due to transport closure.
    expect(wrkfErrorToHttpStatus('WRKF_UNAVAILABLE')).toBe(503)
  })

  // ── Safe default for unknown / future codes ───────────────────────────────
  test('unknown code falls back to 500 (safe default)', () => {
    expect(wrkfErrorToHttpStatus('WRKF_SOME_FUTURE_CODE')).toBe(500)
  })

  test('RPC_* fallback codes (protocol-level errors) fall back to 500', () => {
    // WrkfRpcError.code is "RPC_<n>" when the server omits data.code.
    // These are transport/protocol-level, not domain errors.
    expect(wrkfErrorToHttpStatus('RPC_-32603')).toBe(500)
  })
})
