/**
 * Phase 2e (T-02589) — Generic runtime boundary guard.
 *
 * The wrkf runtime (`src/wrkf/runtime/**`) is the GENERIC workflow engine. It
 * MUST NOT contain any PBC-specific (or otherwise pack-specific) vocabulary —
 * all domain knowledge lives in packs under `src/wrkf/packs/`.
 *
 * This test reads every non-test file under the runtime directory and fails if
 * any forbidden token appears (case-insensitive). It locks the boundary against
 * regressions: if someone reintroduces pack-specific vocabulary into the generic
 * runtime, this test bites.
 *
 * To prove it bites: temporarily add e.g. the comment `// pbc` to any runtime
 * file (not this test) and run `bun test boundary` — it will fail.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Tokens that MUST NOT appear anywhere in the generic runtime. Matched
 * case-insensitively as substrings. These are PBC / pack-specific vocabulary;
 * the generic engine must remain ignorant of them.
 */
const FORBIDDEN_TOKENS = [
  'pbc',
  'pressure',
  'clarification',
  'patch_decision',
  'progressive-refinement',
  'dispose_from_',
  'finalize_ready_pbc',
  'revise_too_vague_pbc',
  'verdict',
  'disposition',
  'behavior_note',
  'pbc_draft',
  'pbc_final',
] as const

/** Recursively collect non-test .ts files under a directory. */
function collectRuntimeSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectRuntimeSourceFiles(full))
      continue
    }
    if (!entry.endsWith('.ts')) continue
    // Skip test files (including this guard) — the boundary applies to the
    // shipped runtime, not to tests, which legitimately reference the tokens.
    if (entry.endsWith('.test.ts')) continue
    out.push(full)
  }
  return out
}

describe('wrkf runtime boundary guard (T-02589)', () => {
  const files = collectRuntimeSourceFiles(RUNTIME_DIR)

  test('discovers at least one runtime source file', () => {
    // Guard against a refactor moving/renaming everything and silently making
    // the boundary checks vacuous.
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = file.slice(RUNTIME_DIR.length + 1)
    test(`runtime/${rel} contains no pack-specific vocabulary`, () => {
      const contents = readFileSync(file, 'utf8').toLowerCase()
      const hits: string[] = []
      for (const token of FORBIDDEN_TOKENS) {
        if (contents.includes(token.toLowerCase())) {
          hits.push(token)
        }
      }
      expect(hits).toEqual([])
    })
  }
})
