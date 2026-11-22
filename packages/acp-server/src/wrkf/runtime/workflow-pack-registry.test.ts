/**
 * WorkflowPack registry resolution (T-02347, T-02402)
 *
 * The caller-visible effect of resolution is the GET /v1/tasks/:taskId `pack`
 * block (handlers/workflow-tasks.ts -> defaultWorkflowPackRegistry). No packs
 * ship since the PBC pack was removed (T-14375), so the production registry
 * resolves every ref to the generic level-0 projection. This file keeps the
 * multi-pack claimed-but-blocked precedence contract (T-02402), driven by a
 * hash-pinned stub pack.
 */

import { describe, expect, test } from 'bun:test'

import { defaultWorkflowPackRegistry } from '../packs/default-registry.js'
import { WorkflowPackRegistry } from './workflow-pack-registry.js'
import type { WorkflowPack } from './workflow-pack.js'

const PINNED_REF = 'pinned-demo@1'
const PINNED_HASH = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'

/** Claims PINNED_REF only; blocks (claimed, unsupported) on a foreign template hash. */
const pinnedPack: WorkflowPack = {
  id: 'pinned',
  displayName: 'Pinned Stub',
  supports: ({ workflowRef, templateHash }) => {
    if (workflowRef !== PINNED_REF) return { supported: false, level: 0 }
    if (templateHash !== undefined && templateHash !== PINNED_HASH) {
      return { supported: false, level: 0, reason: 'template-hash-mismatch', claimed: true }
    }
    return { supported: true, level: 3, claimed: true }
  },
}

describe('default registry', () => {
  test('ships no packs: a former PBC ref resolves to the generic level-0 projection', () => {
    const result = defaultWorkflowPackRegistry.resolve({
      workflowRef: PINNED_REF,
    })

    expect(result.pack).toBeUndefined()
    expect(result.support).toMatchObject({ supported: false, level: 0 })
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
  // RED because: current resolve() only checks supported:true; when pinnedPack
  // returns { supported:false, level:0, reason:'template-hash-mismatch' } the
  // registry falls through to the fallback pack and returns it as the winner.
  // GREEN once: resolve() halts at the first pack whose supports() returns claimed:true.
  //
  describe('claimed-but-blocked: stops at claiming pack, NOT fallback (RED: falls through)', () => {
    test('resolve returns pack.id="pinned" (not "fallback-stub") for the pinned ref with mismatched hash', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pinnedPack)
      // Stub fallback that would "support" anything — must NOT win here
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      const result = registry.resolve({
        workflowRef: PINNED_REF,
        templateHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })

      // the pinned pack claimed this ref; fallback must not override the block
      expect(result.pack?.id).toBe('pinned')
    })

    test('resolve returns supported:false for the pinned ref with mismatched hash (hash-block is terminal)', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pinnedPack)
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      const result = registry.resolve({
        workflowRef: PINNED_REF,
        templateHash: 'sha256:deadbeef00000000000000000000000000000000000000000000000000000000',
      })

      // Must be blocked (false), NOT "supported" by the fallback
      expect(result.support.supported).toBe(false)
    })

    test('resolve surfaces reason="template-hash-mismatch" when the pinned pack claims and blocks', () => {
      const registry = new WorkflowPackRegistry()
      registry.register(pinnedPack)
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      const result = registry.resolve({
        workflowRef: PINNED_REF,
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
      registry.register(pinnedPack)
      registry.register({
        id: 'fallback-stub',
        displayName: 'Fallback Stub',
        supports: () => ({ supported: true, level: 1 }),
      })

      // pinnedPack does NOT claim this ref → unclaimed → fallback wins
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
