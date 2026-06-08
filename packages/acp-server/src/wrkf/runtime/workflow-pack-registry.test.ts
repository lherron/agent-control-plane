/**
 * RED TESTS — Phase 2a: WorkflowPack registry + PBC manifest (T-02347)
 *             Phase 2a-fix: registry claimed-but-blocked semantic (T-02402)
 *
 * Phase 2a tests (groups 1–3) are GREEN: all target modules now exist.
 *
 * Phase 2a-fix tests (groups 4–5) are RED against current code.
 * Current code drops pack.id/reason on unsupported returns and falls through to
 * later packs — breaking the fail-closed template-hash invariant.
 *
 * What the impl agent must change to make groups 4–5 green:
 *
 *   workflow-pack.ts — extend WorkflowPackSupport:
 *     export type WorkflowPackSupport = {
 *       supported: boolean
 *       level: WorkflowPackLevel
 *       reason?: string
 *       claimed?: boolean   // NEW: true when the pack recognises the workflowRef,
 *                           // regardless of hash/safety outcome. Absent or false = unclaimed.
 *     }
 *
 *   packs/pbc/manifest.ts — set claimed signal in supports():
 *     - workflowRef === 'pbc-progressive-refinement@5', hash OK  → { claimed:true, supported:true,  level:3 }
 *     - workflowRef === 'pbc-progressive-refinement@5', hash bad → { claimed:true, supported:false, level:0, reason:'template-hash-mismatch' }
 *     - workflowRef !== 'pbc-progressive-refinement@5'           → { claimed:false, supported:false, level:0 }
 *
 *   workflow-pack-registry.ts — update resolve() priority:
 *     1. First pack returning supported:true → { pack, support }  (unchanged)
 *     2. Else, first pack returning claimed:true → { pack, support }  (NEW: claimed-but-blocked, terminal)
 *        Registry MUST NOT fall through to later packs when a pack is claimed.
 *     3. Else → { support: { supported:false, level:0 } }  (anonymous, no pack)
 *
 * Phase 2a target modules (for reference — already implemented):
 *   src/wrkf/runtime/workflow-pack.ts
 *   src/wrkf/runtime/workflow-pack-registry.ts
 *   src/wrkf/packs/pbc/manifest.ts
 */

import { describe, expect, test } from 'bun:test'

// RED: These imports fail NOW — modules do not exist yet.
// MODULE_NOT_FOUND causes the entire test file to fail to load.
import { pbcManifest } from '../packs/pbc/manifest.js'
import { WorkflowPackRegistry } from './workflow-pack-registry.js'

// ─────────────────────────────────────────────────────────────────────────────
// Test group 1: WorkflowPackRegistry.resolve() — generic routing
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkflowPackRegistry.resolve()', () => {
  // ── 1. Registered PBC manifest resolves for pbc-progressive-refinement@5 ──
  //
  // RED because: WorkflowPackRegistry and pbcManifest do not exist yet.
  // GREEN once: registry.register(pbcManifest) and resolve() delegates to pbcManifest.supports().
  //
  describe('pbc-progressive-refinement@5 → supported: true, level: 3 (RED: modules absent)', () => {
    test('resolve returns supported:true level:3 for workflowRef pbc-progressive-refinement@5 when pbcManifest is registered', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)

      const result = registry.resolve({ workflowRef: 'pbc-progressive-refinement@5' })

      expect(result.support.supported).toBe(true)
      expect(result.support.level).toBe(3)
      expect(result.pack).toBeDefined()
    })

    test('resolved pack.id is "pbc" for pbc-progressive-refinement@5', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)

      const result = registry.resolve({ workflowRef: 'pbc-progressive-refinement@5' })

      expect(result.pack?.id).toBe('pbc')
    })
  })

  // ── 2. Unknown workflow ref → supported: false, level: 0 (no pack) ─────────
  //
  // RED because: WorkflowPackRegistry does not exist yet.
  // GREEN once: resolve() falls through to { support: { supported: false, level: 0 } }
  //             when no registered pack claims the ref.
  //
  describe('unknown workflowRef → supported: false, level: 0 (RED: modules absent)', () => {
    test('resolve returns supported:false level:0 for an unknown workflow ref (empty registry)', () => {
      const registry = new WorkflowPackRegistry()

      const result = registry.resolve({ workflowRef: 'completely-unknown-workflow@99' })

      expect(result.support.supported).toBe(false)
      expect(result.support.level).toBe(0)
      expect(result.pack).toBeUndefined()
    })

    test('resolve returns supported:false level:0 for an unknown ref even when pbcManifest is registered', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)

      const result = registry.resolve({ workflowRef: 'some-other-workflow@2' })

      expect(result.support.supported).toBe(false)
      expect(result.support.level).toBe(0)
      expect(result.pack).toBeUndefined()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test group 2: pbcManifest.supports() — PBC pack boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('pbcManifest.supports()', () => {
  // ── 3. Template-hash mismatch degrades to unsupported (manual/blocked) ──────
  //
  // RED because: pbcManifest does not exist yet.
  // GREEN once: manifest checks templateHash against its pinned hash and returns
  //             { supported: false, level: 0, reason: 'template-hash-mismatch' }
  //             on mismatch — NOT best-effort (level 1).
  //
  // This is a safety guard: an unknown/modified template hash means we cannot trust
  // the compiled prompt, parser, or transition policy. Block rather than degrade silently.
  //
  describe('template-hash mismatch → supported:false, reason:template-hash-mismatch (RED: manifest absent)', () => {
    test('supports() with wrong templateHash returns supported:false level:0 reason:template-hash-mismatch', () => {
      const result = pbcManifest.supports({
        workflowRef: 'pbc-progressive-refinement@5',
        // A hash that is clearly not the real PBC template hash
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      expect(result.supported).toBe(false)
      expect(result.level).toBe(0)
      expect(result.reason).toBe('template-hash-mismatch')
    })

    test('hash mismatch result is NOT best-effort (level must be 0, not 1)', () => {
      const result = pbcManifest.supports({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:deadbeef00000000000000000000000000000000000000000000000000000000',
      })

      // Explicitly assert level 0, not 1 (best-effort) or 3 (full).
      // A modified/unknown template hash is treated as manual/blocked, not best-effort.
      expect(result.level).toBe(0)
    })
  })

  // ── 4. No hash provided → no degradation ────────────────────────────────────
  //
  // RED because: pbcManifest does not exist yet.
  // GREEN once: manifest returns { supported: true, level: 3 } when no hash is given
  //             (hash-pinning only fires when a hash IS provided and mismatches).
  //
  describe('no templateHash → supported:true level:3 (RED: manifest absent)', () => {
    test('supports() without templateHash returns supported:true level:3 for pbc-progressive-refinement@5', () => {
      const result = pbcManifest.supports({
        workflowRef: 'pbc-progressive-refinement@5',
        // No templateHash — hash-pin guard must NOT fire
      })

      expect(result.supported).toBe(true)
      expect(result.level).toBe(3)
    })
  })

  // ── 5. Unknown workflowRef → unsupported ─────────────────────────────────────
  //
  // RED because: pbcManifest does not exist yet.
  // GREEN once: manifest's supports() checks the workflowRef and returns
  //             { supported: false, level: 0 } for any ref it doesn't claim.
  //
  describe('unknown workflowRef → supported:false level:0 (RED: manifest absent)', () => {
    test('supports() returns supported:false for workflowRef that is not pbc-progressive-refinement@5', () => {
      const result = pbcManifest.supports({
        workflowRef: 'agent-tasker-feature-request@3',
      })

      expect(result.supported).toBe(false)
      expect(result.level).toBe(0)
    })

    test('supports() returns supported:false for pbc-progressive-refinement with wrong version', () => {
      // Only @5 is supported; earlier versions are not
      const result = pbcManifest.supports({
        workflowRef: 'pbc-progressive-refinement@4',
      })

      expect(result.supported).toBe(false)
      expect(result.level).toBe(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test group 3: WorkflowPackRegistry PBC boundary — no PBC strings in runtime/
// ─────────────────────────────────────────────────────────────────────────────
//
// This is a source-level lint assertion that verifies the boundary is enforced:
// workflow-pack-registry.ts must NOT contain PBC-specific strings.
// PBC strings are only allowed in packs/pbc/manifest.ts.
//
// RED because: workflow-pack-registry.ts does not exist yet.
// GREEN once: impl creates workflow-pack-registry.ts without PBC strings.
//

describe('WorkflowPackRegistry source boundary: no PBC strings in runtime/', () => {
  test('workflow-pack-registry.ts source must not contain pbc-specific strings', async () => {
    // Dynamic import avoids the module-not-found error for the source text check.
    // We read the source as text to verify the boundary.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('./workflow-pack-registry.ts', import.meta.url),
      'utf-8'
    )
    // These strings are only allowed in packs/pbc/manifest.ts
    expect(src).not.toMatch(/pbc/i)
    expect(src).not.toMatch(/progressive.refinement/i)
    expect(src).not.toMatch(/pressure/i)
    expect(src).not.toMatch(/clarification/i)
    expect(src).not.toMatch(/patch_decision/i)
  })

  test('workflow-pack.ts source must not contain pbc-specific strings', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('./workflow-pack.ts', import.meta.url),
      'utf-8'
    )
    expect(src).not.toMatch(/pbc/i)
    expect(src).not.toMatch(/progressive.refinement/i)
    expect(src).not.toMatch(/pressure/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test group 4: WorkflowPackRegistry.resolve() — claimed-but-blocked (T-02402)
// ─────────────────────────────────────────────────────────────────────────────
//
// RED tests (4a, 4b): fail against current code because resolve() falls through
// to later packs when a pack returns supported:false, discarding pack.id + reason.
//
// GREEN (contrast, 4c): unclaimed refs already fall through correctly — these
// tests pass now and must continue to pass after the fix to verify the boundary
// between claimed-but-blocked (terminal) and truly unclaimed (falls through).
//
// Stub fallback used throughout:
//   id: 'fallback-stub'
//   supports() → { supported: true, level: 1 } for any ref
//   Simulates a generic catch-all that must NOT win over a claiming pack.

describe('WorkflowPackRegistry.resolve() — claimed-but-blocked semantic (T-02402)', () => {
  // ── 4a. Claimed-but-blocked must NOT fall through to a later pack ─────────
  //
  // RED because: current resolve() only checks supported:true; when pbcManifest
  // returns { supported:false, level:0, reason:'template-hash-mismatch' } the
  // registry falls through to the fallback pack and returns it as the winner.
  // GREEN once: resolve() halts at the first pack whose supports() returns claimed:true.
  //
  describe('claimed-but-blocked: stops at claiming pack, NOT fallback (RED: falls through)', () => {
    test('resolve returns pack.id="pbc" (not "fallback-stub") for pbc ref with mismatched hash', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)
      // Stub fallback that would "support" anything — must NOT win here
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      const result = registry.resolve({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      // pbc claimed this ref; fallback must not override the block
      expect(result.pack?.id).toBe('pbc')
    })

    test('resolve returns supported:false for pbc ref with mismatched hash (hash-block is terminal)', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      const result = registry.resolve({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:deadbeef00000000000000000000000000000000000000000000000000000000',
      })

      // Must be blocked (false), NOT "supported" by the fallback
      expect(result.support.supported).toBe(false)
    })

    test('resolve surfaces reason="template-hash-mismatch" when pbc claims and blocks', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      const result = registry.resolve({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:deadbeef00000000000000000000000000000000000000000000000000000000',
      })

      // Reason from the claiming pack must be preserved in the resolution
      expect(result.support.reason).toBe('template-hash-mismatch')
    })
  })

  // ── 4b. Claimed-but-blocked: pack.id and reason preserved even without fallback
  //
  // RED because: current resolve() returns { support: { ...UNSUPPORTED } } which
  // has no pack and no reason, discarding both from the pack's own supports() return.
  // GREEN once: first claimed pack's { pack, support } is returned unchanged.
  //
  describe('claimed-but-blocked: resolution includes pack.id and reason (no fallback) (RED: drops id+reason)', () => {
    test('resolve includes pack.id="pbc" for hash-mismatch with only pbcManifest registered', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)

      const result = registry.resolve({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      // Currently undefined — registry sets pack only when supported:true
      expect(result.pack?.id).toBe('pbc')
    })

    test('resolve includes support.reason="template-hash-mismatch" for hash-mismatch (no fallback)', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)

      const result = registry.resolve({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      // Currently undefined — UNSUPPORTED constant has no reason field
      expect(result.support.reason).toBe('template-hash-mismatch')
    })

    test('resolve returns support.level=0 for hash-mismatch (blocked, not best-effort)', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)

      const result = registry.resolve({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      expect(result.support.level).toBe(0)
    })
  })

  // ── 4c. Contrast: truly unclaimed ref falls through to fallback (GREEN now) ──
  //
  // These tests pass against current code and must continue to pass after the fix.
  // They document that fallthrough is correct for unclaimed refs — only claimed refs
  // (claimed:true) are terminal.
  //
  describe('contrast — unclaimed workflowRef falls through to fallback (GREEN: must stay green)', () => {
    test('resolve falls through to fallback-stub for a ref no pack claims', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      // pbcManifest does NOT claim this ref → unclaimed → fallback wins
      const result = registry.resolve({ workflowRef: 'some-other-workflow@7' })

      expect(result.support.supported).toBe(true)
      expect(result.pack?.id).toBe('fallback-stub')
    })

    test('resolve returns anonymous unsupported for unclaimed ref when no fallback registered', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pbcManifest)

      const result = registry.resolve({ workflowRef: 'some-other-workflow@7' })

      expect(result.support.supported).toBe(false)
      expect(result.pack).toBeUndefined()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test group 5: pbcManifest.supports() — claimed signal (T-02402)
// ─────────────────────────────────────────────────────────────────────────────
//
// RED because: WorkflowPackSupport has no `claimed` field yet; pbcManifest does
// not set it. Tests access result.claimed directly (test files are excluded from
// tsc; Bun transpiles without type checking — undefined at runtime → fail red).
//
// GREEN once: WorkflowPackSupport gains `claimed?: boolean`; pbcManifest sets
// claimed:true when workflowRef === 'pbc-progressive-refinement@5' (any hash),
// claimed:false (or absent) for all other refs.
//
describe('pbcManifest.supports() — claimed signal (T-02402)', () => {
  // ── 5a. claimed:true for pbc ref (hash OK) ───────────────────────────────────
  //
  // RED because: claimed field is absent — result.claimed evaluates to undefined.
  // GREEN once: supports() sets claimed:true for the pbc ref.
  //
  describe('claimed:true when ref matches and hash is correct (RED: claimed absent)', () => {
    test('supports() sets claimed:true for pbc-progressive-refinement@5 with no templateHash', () => {
      const result = pbcManifest.supports({
        workflowRef: 'pbc-progressive-refinement@5',
        // No hash — should return { claimed:true, supported:true, level:3 }
      })

      // result.claimed is currently undefined (field does not exist)
      expect((result as { claimed?: boolean }).claimed).toBe(true)
    })
  })

  // ── 5b. claimed:true for pbc ref even when hash mismatches (claimed-but-blocked)
  //
  // RED because: claimed field absent AND result.claimed === undefined !== true.
  // GREEN once: supports() always sets claimed:true for the pbc ref, regardless
  //             of hash outcome. The block is communicated via supported:false +
  //             reason, NOT via claimed:false.
  //
  describe('claimed:true when ref matches but hash mismatches (RED: claimed absent)', () => {
    test('supports() sets claimed:true for pbc ref with mismatched templateHash', () => {
      const result = pbcManifest.supports({
        workflowRef: 'pbc-progressive-refinement@5',
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      // Pack recognises the ref; claimed:true even though hash blocks it.
      // This is what tells the registry not to fall through.
      expect((result as { claimed?: boolean }).claimed).toBe(true)
    })
  })

  // ── 5c. claimed:false (or absent) when ref does not match ──────────────────
  //
  // Behaviorally passes now (undefined is falsy) but explicitly documents the
  // contract: non-pbc refs must NOT set claimed:true.
  //
  describe('claimed:false (or absent) when ref does not match (documents contract)', () => {
    test('supports() does not set claimed:true for a non-pbc workflowRef', () => {
      const result = pbcManifest.supports({
        workflowRef: 'some-other-workflow@7',
      })

      // Must be falsy — undefined or false both satisfy this
      expect((result as { claimed?: boolean }).claimed).toBeFalsy()
    })
  })
})
