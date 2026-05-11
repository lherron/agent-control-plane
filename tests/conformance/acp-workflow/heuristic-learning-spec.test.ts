import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../../..')

describe('heuristic learning implementation spec markers', () => {
  test('spec and implementation log mark every requested phase complete', () => {
    const spec = readFileSync(join(repoRoot, 'heuristic-learning-acp-hrc-spec.md'), 'utf8')
    const log = readFileSync(join(repoRoot, 'HEURISTIC_LEARNING_IMPLEMENTATION.md'), 'utf8')

    for (const phase of [
      'Phase 1: ACP/HRC capture foundation',
      'Phase 2: deterministic workflow replay',
      'Phase 3: low-authority learning workflows',
      'Phase 4: high-authority proposal and replay workflows',
      'Phase 5: promotion, rollback, and audit workflows',
      'Phase 6: learning-workflow self-improvement governance',
      '`wlearn` downstream tooling',
    ]) {
      expect(spec).toContain(`[x] ${phase}`)
    }

    for (const section of [
      'Phase 1: ACP/HRC Capture Foundation',
      'Phase 2: Deterministic Workflow Replay',
      'Phase 3: Low-Authority Learning Workflows',
      'Phase 4: High-Authority Proposal and Replay Workflows',
      'Phase 5: Promotion, Rollback, and Audit Workflows',
      'Phase 6: Learning-Workflow Self-Improvement Governance',
      'wlearn Tooling',
    ]) {
      expect(log).toContain(`## ${section}`)
    }
    expect(log.match(/Status: Complete/g)?.length).toBeGreaterThanOrEqual(7)
    expect(log).toContain('Manual smoke')
  })
})
