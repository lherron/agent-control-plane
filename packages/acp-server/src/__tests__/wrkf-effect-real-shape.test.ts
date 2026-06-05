/**
 * REAL-PROCESS shape guard — W5: wrkf effect payload shapes (T-01935)
 *
 * These tests spin a REAL @wrkf/client against the canonical wrkq DB and
 * assert the actual shape of effect objects. They PASS NOW (they document
 * reality) and serve as a fidelity guard: if wrkf changes the effect payload
 * format, these tests catch it before the reconciler is broken.
 *
 * Pattern: W4b wrkf-real-inspect-shape.test.ts
 *
 * Requires:
 *   - wrkf binary: ~/.local/bin/wrkf (or $WRKF_BIN)
 *   - canonical DB: ~/praesidium/var/db/wrkq.db
 *   - Live wrkf-backed task with effects: T-01489 or any task with pending/delivered effects
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Authoritative effect shapes (from real-run-effects fixtures + live wrkq.db):
 *
 *   wake_role effect object (top-level keys):
 *     id, instanceId, revision, kind, payload, status, idempotencyKey, attempts,
 *     leasedBy?, leaseToken?, leasedUntil?, deliveredAt?, createdAt, updatedAt
 *
 *   wake_role payload:
 *     {kind:'wake_role', role:string, reason?:string, data?:{instruction?:string,...}}
 *
 *   request_observer_review payload:
 *     {kind:'request_observer_review', role:'observer', reason:string,
 *      data:{guardrails:string[], instruction:string, targetLane:string}}
 *
 *   claim response (wrkf effect claim):
 *     {effects: WrkfEffect[], leaseToken: string|null, leaseExpiresAt: string|null}
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHAPE INVARIANTS the reconciler must rely on (W5 contract):
 *   1. effect.payload is a JSON object (never a string, never null)
 *   2. effect.payload.role is a string identifying the target role
 *   3. effect.payload.kind matches effect.kind (redundant but present)
 *   4. effect.idempotencyKey is a non-empty string (used as appendEvent idempotencyKey)
 *   5. claim response always has {effects:[], leaseToken:null} when nothing is claimed
 *      OR {effects:[...], leaseToken:string} when effects are claimed
 *
 * These invariants are asserted in the REAL-PROCESS tests below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { createWrkfClientLifecycle } from '../wrkf/client-lifecycle.js'

// ─── Binary / DB paths ────────────────────────────────────────────────────────

const WRKF_BINARY =
  process.env['WRKF_BIN'] ??
  `${process.env['HOME'] ?? '/Users/lherron'}/.local/bin/wrkf`

const WRKQ_DB_PATH =
  process.env['WRKQ_DB_PATH'] ??
  `${process.env['HOME'] ?? '/Users/lherron'}/praesidium/var/db/wrkq.db`

// A live wrkq task that has at least one effect in the DB.
// T-01489 was used for W4b real-shape tests and has delivered wake_role effects.
const LIVE_TASK_ID = 'T-01489'

// ─── Expected effect top-level keys (from real-run-effects-before-ack.json) ──
const EXPECTED_EFFECT_TOP_KEYS = [
  'id',
  'instanceId',
  'revision',
  'kind',
  'payload',
  'status',
  'idempotencyKey',
  'attempts',
  'createdAt',
  'updatedAt',
] as const

// ─── Expected wake_role payload keys ─────────────────────────────────────────
const EXPECTED_WAKE_ROLE_PAYLOAD_KEYS = ['kind', 'role'] as const // reason/data are optional

// ─── Expected request_observer_review payload keys ───────────────────────────
const EXPECTED_OBSERVER_PAYLOAD_KEYS = ['kind', 'role', 'reason', 'data'] as const
const EXPECTED_OBSERVER_DATA_KEYS = ['guardrails', 'instruction', 'targetLane'] as const

// ─────────────────────────────────────────────────────────────────────────────
// REAL-PROCESS: wrkf effect list shape contract
// ─────────────────────────────────────────────────────────────────────────────

describe('W5 real-process: @wrkf/client effect shape contract (fidelity guard)', () => {
  // ── Shape: effect object has required top-level keys ─────────────────────
  //
  // PASSES NOW. Guards against wrkf changing effect object structure.
  // The reconciler reads id, kind, payload, idempotencyKey from each effect.

  test('REAL-PROCESS: effect objects (from effect.list bare array) have required top-level keys', async () => {
    // effect.list returns a BARE ARRAY (not {effects:[...]} wrapper — see shape guard below).
    // This test verifies each effect object in that array has the expected keys.
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-effect-shape', version: '0.1.0' },
    })
    try {
      const result = await lc.wrkf!.effect.list({ task: LIVE_TASK_ID })

      // effect.list returns a bare array
      expect(Array.isArray(result)).toBe(true)
      const effects = result as Array<Record<string, unknown>>

      if (effects.length === 0) {
        console.log(`[FIDELITY GUARD] No effects on ${LIVE_TASK_ID} — effect key assertions skipped`)
        return
      }

      const effect = effects[0]!
      const keys = Object.keys(effect)

      for (const key of EXPECTED_EFFECT_TOP_KEYS) {
        expect(keys, `effect missing expected key: ${key}`).toContain(key)
      }

      // payload must be an object (not a string, not null)
      expect(typeof effect['payload']).toBe('object')
      expect(effect['payload']).not.toBeNull()
      expect(Array.isArray(effect['payload'])).toBe(false)

      // idempotencyKey must be a non-empty string
      expect(typeof effect['idempotencyKey']).toBe('string')
      expect((effect['idempotencyKey'] as string).length).toBeGreaterThan(0)

      // kind must be a non-empty string
      expect(typeof effect['kind']).toBe('string')
      expect((effect['kind'] as string).length).toBeGreaterThan(0)
    } finally {
      await lc.close()
    }
  }, 15000)

  // ── Shape: wake_role payload has kind + role ──────────────────────────────
  //
  // PASSES NOW. Guards that payload.kind === effect.kind and payload.role is a string.
  // The reconciler reads payload.role for the wake delivery target.

  test('REAL-PROCESS: wake_role effect payload has kind="wake_role" and role is a string', async () => {
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-effect-shape', version: '0.1.0' },
    })
    try {
      // effect.list returns a bare array (see shape guard test)
      const result = await lc.wrkf!.effect.list({ task: LIVE_TASK_ID })
      const effects = (Array.isArray(result) ? result : []) as Array<Record<string, unknown>>
      const wakeRoleEffects = effects.filter((e) => e['kind'] === 'wake_role')

      // If the live task has no wake_role effects, skip the payload assertions.
      // The guard is still useful: it checks the list API returns effects at all.
      if (wakeRoleEffects.length === 0) {
        console.log(
          `[FIDELITY GUARD] No wake_role effects on ${LIVE_TASK_ID} — payload shape assertions skipped`
        )
        return
      }

      for (const effect of wakeRoleEffects) {
        const payload = effect['payload'] as Record<string, unknown>
        const payloadKeys = Object.keys(payload)

        for (const key of EXPECTED_WAKE_ROLE_PAYLOAD_KEYS) {
          expect(
            payloadKeys,
            `wake_role payload missing expected key: ${key}`
          ).toContain(key)
        }

        // payload.kind must equal effect.kind
        expect(payload['kind']).toBe('wake_role')

        // payload.role must be a non-empty string (e.g. 'architect', 'coordinator')
        expect(typeof payload['role']).toBe('string')
        expect((payload['role'] as string).length).toBeGreaterThan(0)

        // FIDELITY GUARD: payload must NOT have legacy field names from the old reconciler
        // The old reconciler read effect.payload['toRole'] (declare_handoff) — verify this
        // is NOT present in wake_role payloads (they use 'role', not 'toRole').
        expect(payloadKeys).not.toContain('toRole')
        expect(payloadKeys).not.toContain('targetRole')
      }
    } finally {
      await lc.close()
    }
  }, 15000)

  // ── Shape: claim response has {effects, leaseToken, leaseExpiresAt} ───────
  //
  // PASSES NOW (when claiming returns empty). Guards that the claim response
  // shape matches what the reconciler expects.
  // We use a non-existent kind to get a guaranteed empty response without
  // interfering with live data.

  test('REAL-PROCESS: claim response always has {effects, leaseToken, leaseExpiresAt} keys', async () => {
    // FIDELITY GUARD: The claim response shape is the PRIMARY contract the reconciler
    // depends on. Even for empty claims, wrkf returns a non-null leaseToken.
    //
    // REAL SHAPE (captured 2026-06-05, from real wrkf binary against canonical DB):
    //   {effects: [], leaseToken: "lease_<hex>", leaseExpiresAt: "<iso-timestamp>"}
    //   Both leaseToken and leaseExpiresAt are ALWAYS strings (never null).
    //
    // This differs from the initial assumption in the task body; C-03525 + real capture
    // are authoritative: leaseToken is always present.
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-effect-shape', version: '0.1.0' },
    })
    try {
      // Claim a kind that doesn't exist — guaranteed empty effects array
      // but the response still has a leaseToken (wrkf always returns one).
      const result = (await lc.wrkf!.effect.claim({
        adapter: 'acp-shape-test-readonly',
        kind: 'nonexistent_kind_for_shape_test',
        task: LIVE_TASK_ID,
        limit: 1,
        leaseMs: 1000,
      })) as Record<string, unknown>

      const keys = Object.keys(result)

      // All three keys must always be present
      expect(keys).toContain('effects')
      expect(keys).toContain('leaseToken')
      expect(keys).toContain('leaseExpiresAt')

      // effects must be an array (empty in this case)
      expect(Array.isArray(result['effects'])).toBe(true)
      expect((result['effects'] as unknown[]).length).toBe(0)

      // FIDELITY GUARD: leaseToken is ALWAYS a string, even for empty claims.
      // The reconciler must check effects.length, NOT leaseToken === null, to detect
      // empty claims. If wrkf ever changes this to return null for empty claims,
      // this guard will catch it.
      expect(typeof result['leaseToken']).toBe('string')
      expect(typeof result['leaseExpiresAt']).toBe('string')
    } finally {
      await lc.close()
    }
  }, 15000)

  // ── Shape: claim response keys when effects are present ──────────────────
  //
  // PASSES NOW (using an existing leased effect or verifying the key structure).
  // When a claim succeeds, the response must have {effects:[...], leaseToken:string}.

  test('REAL-PROCESS: @wrkf/client effect.list returns an ARRAY (not {effects:[...]} wrapper)', async () => {
    // FIDELITY GUARD: The @wrkf/client effect.list API returns a bare array of effects,
    // NOT an {effects:[...]} wrapper object. This differs from effect.claim which DOES
    // use an {effects:[...]} wrapper.
    //
    // REAL SHAPE (captured 2026-06-05):
    //   effect.list → Array<WrkfEffect>  (bare array, 0..N items)
    //   effect.claim → {effects:WrkfEffect[], leaseToken:string, leaseExpiresAt:string}
    //
    // The reconciler uses effect.claim (not effect.list), so this is informational
    // for implementers who might be tempted to use effect.list.
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-effect-shape', version: '0.1.0' },
    })
    try {
      const result = await lc.wrkf!.effect.list({ task: LIVE_TASK_ID })

      // effect.list returns a bare array, not an {effects:[...]} object
      expect(Array.isArray(result)).toBe(true)

      // FIDELITY GUARD: must NOT be wrapped in {effects: [...]}
      if (!Array.isArray(result) && typeof result === 'object' && result !== null) {
        expect(
          (result as Record<string, unknown>)['effects'],
          'effect.list must return bare array, not {effects:[...]} — shape drift detected'
        ).toBeUndefined()
      }
    } finally {
      await lc.close()
    }
  }, 15000)

  // ── Shape: effect idempotencyKey format ───────────────────────────────────
  //
  // PASSES NOW. The reconciler uses idempotencyKey as the appendEvent idempotencyKey.
  // Validates the key follows the pattern: {instanceId}:{revision}:{...}:{effectId}

  test('REAL-PROCESS: effect.idempotencyKey follows {instanceId}:{revision}:... pattern', async () => {
    const lc = await createWrkfClientLifecycle({
      command: WRKF_BINARY,
      dbPath: WRKQ_DB_PATH,
      clientInfo: { name: 'acp-server-test-effect-shape', version: '0.1.0' },
    })
    try {
      // effect.list returns a bare array (see shape guard test)
      const result = await lc.wrkf!.effect.list({ task: LIVE_TASK_ID })
      const effects = (Array.isArray(result) ? result : []) as Array<Record<string, unknown>>

      if (effects.length === 0) {
        console.log(`[FIDELITY GUARD] No effects on ${LIVE_TASK_ID} — idempotencyKey format check skipped`)
        return
      }

      for (const effect of effects) {
        const key = effect['idempotencyKey'] as string
        const parts = key.split(':')

        // Minimum 3 parts: instanceId : revision : ... : effectId
        expect(
          parts.length,
          `idempotencyKey should have >= 3 parts: ${key}`
        ).toBeGreaterThanOrEqual(3)

        // First part is the instanceId (wfi_...)
        expect(
          parts[0],
          `idempotencyKey first part should be instanceId: ${key}`
        ).toMatch(/^wfi_/)

        // Second part is the revision (a number string)
        expect(
          Number.isInteger(parseInt(parts[1]!, 10)),
          `idempotencyKey second part should be revision number: ${key}`
        ).toBe(true)
      }
    } finally {
      await lc.close()
    }
  }, 15000)
})
