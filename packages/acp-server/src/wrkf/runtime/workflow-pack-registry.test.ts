/**
 * WorkflowPack registry + PBC manifest resolution (T-02347, T-02402)
 *
 * The caller-visible effect of resolution is the GET /v1/tasks/:taskId `pack`
 * block (handlers/workflow-tasks.ts -> defaultWorkflowPackRegistry). The plain
 * supported / unknown-ref projections are asserted there, in
 * src/__tests__/wrkf-workflow-pack-projection.test.ts. This file keeps:
 *   - the template-hash fail-closed resolution through the production default
 *     registry (no route test covers a mismatched hash yet; rewrite-held),
 *   - the versioned-ref exact-match guard,
 *   - the multi-pack claimed-but-blocked precedence contract (T-02402).
 */

import { describe, expect, test } from 'bun:test'

import { defaultWorkflowPackRegistry } from '../packs/default-registry.js'
import { pbcManifest } from '../packs/pbc/manifest.js'
import { WorkflowPackRegistry } from './workflow-pack-registry.js'

describe('PBC pack resolution', () => {
  // A modified/unknown template hash means the compiled prompt, parser and
  // transition policy cannot be trusted: block (level 0) rather than degrade to
  // best-effort (level 1). The claiming pack's id is kept so callers can see
  // which pack blocked the task.
  describe('template-hash pinning', () => {
    test('a pbc ref with a mismatched templateHash resolves blocked: pack pbc, supported:false, level 0, reason template-hash-mismatch', () => {
      const result = defaultWorkflowPackRegistry.resolve({
        workflowRef: 'pbc-progressive-refinement@9',
        // A hash that is clearly not the real PBC template hash
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      expect(result.pack?.id).toBe('pbc')
      expect(result.support).toMatchObject({
        supported: false,
        level: 0,
        reason: 'template-hash-mismatch',
      })
    })
  })

  describe('versioned workflowRef', () => {
    test('pbc-progressive-refinement at another version is not supported (exact ref match, no prefix match)', () => {
      // Only @9 is supported; earlier versions are not
      const result = pbcManifest.supports({
        workflowRef: 'pbc-progressive-refinement@4',
      })

      expect(result.supported).toBe(false)
      expect(result.level).toBe(0)
    })
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
        workflowRef: 'pbc-progressive-refinement@9',
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
        workflowRef: 'pbc-progressive-refinement@9',
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
        workflowRef: 'pbc-progressive-refinement@9',
        templateHash: 'sha256:deadbeef00000000000000000000000000000000000000000000000000000000',
      })

      // Reason from the claiming pack must be preserved in the resolution
      expect(result.support.reason).toBe('template-hash-mismatch')
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
  })
})

describe('empty registry boundary', () => {
  test('resolve returns supported:false level:0 for an unknown workflow ref (empty registry)', () => {
    const registry = new WorkflowPackRegistry()

    const result = registry.resolve({ workflowRef: 'completely-unknown-workflow@99' })

    expect(result.support.supported).toBe(false)
    expect(result.support.level).toBe(0)
    expect(result.pack).toBeUndefined()
  })
})
