/**
 * RED TESTS — Phase 2a: WorkflowPack registry + PBC manifest (T-02347)
 *
 * All tests fail NOW because the target modules do not exist yet.
 * Bun will report MODULE_NOT_FOUND for every import in this file.
 *
 * Target modules (NEW, not-yet-created):
 *   src/wrkf/runtime/workflow-pack.ts          (WorkflowPackLevel, WorkflowPackSupport, WorkflowPack types)
 *   src/wrkf/runtime/workflow-pack-registry.ts (WorkflowPackRegistry class with register()/resolve())
 *   src/wrkf/packs/pbc/manifest.ts             (pbcManifest — ONLY place PBC ref strings are allowed)
 *
 * What the impl agent must create to make these tests green:
 *
 *   workflow-pack.ts:
 *     export type WorkflowPackLevel = 0 | 1 | 2 | 3
 *     export type WorkflowPackSupport = { supported: boolean; level: WorkflowPackLevel; reason?: string }
 *     export type WorkflowPack = {
 *       id: string
 *       displayName: string
 *       supports(input: { workflowRef: string; workflowId?: string; version?: string; templateHash?: string; template?: unknown }): WorkflowPackSupport
 *       compilePrompt?: (...)  => ...
 *       parseParticipantOutput?: (...) => ...
 *       mapHumanInput?: (...) => ...
 *       chooseTransition?: (...) => ...
 *       project?: (...) => ...
 *       workerPolicy?: ...
 *     }
 *
 *   workflow-pack-registry.ts:
 *     export class WorkflowPackRegistry {
 *       register(pack: WorkflowPack): void
 *       resolve(input: { workflowRef: string; workflowId?: string; version?: string; templateHash?: string }):
 *         { pack?: WorkflowPack; support: WorkflowPackSupport }
 *     }
 *     // Picks first registered pack whose supports() returns { supported: true }; else:
 *     //   return { support: { supported: false, level: 0 } }
 *     // MUST be PBC-free: no 'pbc', 'progressive-refinement', 'pressure', etc. strings.
 *
 *   packs/pbc/manifest.ts:
 *     export const pbcManifest: WorkflowPack = {
 *       id: 'pbc',
 *       displayName: 'PBC Progressive Refinement',
 *       supports({ workflowRef, templateHash }) {
 *         // Recognise 'pbc-progressive-refinement@5' only
 *         if (workflowRef !== 'pbc-progressive-refinement@5') return { supported: false, level: 0 }
 *         // When templateHash is provided, pin it; mismatch → manual/blocked (NOT best-effort)
 *         if (templateHash !== undefined && templateHash !== KNOWN_TEMPLATE_HASH)
 *           return { supported: false, level: 0, reason: 'template-hash-mismatch' }
 *         return { supported: true, level: 3 }
 *       },
 *       // Optional method slots: leave all undefined for Phase 2a (extracted in 2b-2d)
 *     }
 *     // KNOWN_TEMPLATE_HASH is the sha256 of wrkq/pbc/workflow-template.json
 *     // formatted as 'sha256:<hex>' — the format wrkf task inspect returns in templateHash.
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
