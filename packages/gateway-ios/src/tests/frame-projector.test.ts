import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { projectIncremental, projectTimeline } from '../frame-projector.js'
import type { ReducerInput } from '../types.js'

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, 'fixtures')

function loadFixture(name: string): ReducerInput[] {
  const content = readFileSync(join(FIXTURES_DIR, name), 'utf-8')
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ReducerInput)
}

// ---------------------------------------------------------------------------
// Fixture-driven projection tests
// ---------------------------------------------------------------------------

describe('frame-projector: fixture projection', () => {
  const fixtures = [
    'claude-prompt-response.ndjson',
    'claude-tool-use.ndjson',
    'codex-prompt-response.ndjson',
    'codex-tool-use.ndjson',
    'interrupted-turn.ndjson',
    'stale-generation.ndjson',
  ]

  for (const fixture of fixtures) {
    it(`${fixture} produces non-empty, deterministic frames`, () => {
      const inputs = loadFixture(fixture)
      const result = projectTimeline(inputs)

      // Non-empty
      expect(result.frames.length).toBeGreaterThan(0)

      // Ordered by frameSeq (oldest-first)
      for (let i = 1; i < result.frames.length; i++) {
        expect(result.frames[i]!.frameSeq).toBeGreaterThan(result.frames[i - 1]!.frameSeq)
      }

      // Deterministic: running again produces same result
      const result2 = projectTimeline(inputs)
      expect(result2.frames.length).toBe(result.frames.length)
      for (let i = 0; i < result.frames.length; i++) {
        expect(result2.frames[i]!.frameId).toBe(result.frames[i]!.frameId)
        expect(result2.frames[i]!.frameKind).toBe(result.frames[i]!.frameKind)
        expect(result2.frames[i]!.lastHrcSeq).toBe(result.frames[i]!.lastHrcSeq)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Frame ordering
// ---------------------------------------------------------------------------

describe('frame-projector: ordering', () => {
  it('frames are ordered oldest-first by frameSeq', () => {
    const inputs = loadFixture('claude-tool-use.ndjson')
    const { frames } = projectTimeline(inputs)

    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.frameSeq).toBeGreaterThan(frames[i - 1]!.frameSeq)
    }
  })

  it('frame creation order matches event processing order', () => {
    const inputs = loadFixture('claude-prompt-response.ndjson')
    const { frames } = projectTimeline(inputs)

    // session_status should be created before user_prompt (session.created comes first)
    const sessionIdx = frames.findIndex((f) => f.frameKind === 'session_status')
    const userIdx = frames.findIndex((f) => f.frameKind === 'user_prompt')
    expect(sessionIdx).toBeLessThan(userIdx)
  })
})

// ---------------------------------------------------------------------------
// Idempotency under projection
// ---------------------------------------------------------------------------

describe('frame-projector: idempotency', () => {
  it('projecting same inputs twice produces same frame count', () => {
    const inputs = loadFixture('claude-prompt-response.ndjson')

    // Project all inputs, then project again (double delivery)
    const doubled = [...inputs, ...inputs]
    const result = projectTimeline(doubled)

    // Should have same frame count as single pass (dedup)
    const singleResult = projectTimeline(inputs)
    expect(result.frames.length).toBe(singleResult.frames.length)
  })

  it('no duplicate sourceEvents after double delivery', () => {
    const inputs = loadFixture('claude-tool-use.ndjson')
    const doubled = [...inputs, ...inputs]
    const { frames } = projectTimeline(doubled)

    for (const frame of frames) {
      const hrcSeqs = frame.sourceEvents.map((se) => se.hrcSeq)
      const uniqueSeqs = new Set(hrcSeqs)
      expect(hrcSeqs.length).toBe(uniqueSeqs.size)
    }
  })
})

// ---------------------------------------------------------------------------
// Incremental projection
// ---------------------------------------------------------------------------

describe('frame-projector: incremental', () => {
  it('incremental projection continues from prior state', () => {
    const inputs = loadFixture('claude-prompt-response.ndjson')

    // Split into two halves
    const firstHalf = inputs.slice(0, 4)
    const secondHalf = inputs.slice(4)

    // Project first half
    const firstResult = projectTimeline(firstHalf)
    const firstFrameCount = firstResult.frames.length

    // Continue with second half
    const incrResult = projectIncremental(firstResult.state, secondHalf)

    // Should have more frames or updated frames
    expect(incrResult.frames.length).toBeGreaterThanOrEqual(firstFrameCount)

    // Full projection should match
    const fullResult = projectTimeline(inputs)
    expect(incrResult.frames.length).toBe(fullResult.frames.length)
  })

  it('incremental state preserves high-water marks', () => {
    const inputs = loadFixture('claude-prompt-response.ndjson')
    const result = projectTimeline(inputs)

    expect(result.state.highWaterHrcSeq).toBe(8)
    expect(result.state.nextFrameSeq).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// Frame content verification per fixture
// ---------------------------------------------------------------------------

describe('frame-projector: claude-prompt-response content', () => {
  it('has session_status, turn_status, user_prompt, assistant_message', () => {
    const { frames } = projectTimeline(loadFixture('claude-prompt-response.ndjson'))
    const kinds = new Set(frames.map((f) => f.frameKind))

    expect(kinds.has('session_status')).toBe(true)
    expect(kinds.has('turn_status')).toBe(true)
    expect(kinds.has('user_prompt')).toBe(true)
    expect(kinds.has('assistant_message')).toBe(true)
  })
})

describe('frame-projector: claude-tool-use content', () => {
  it('has tool_call frame with both call and result blocks', () => {
    const { frames } = projectTimeline(loadFixture('claude-tool-use.ndjson'))
    const toolFrame = frames.find((f) => f.frameKind === 'tool_call')!

    expect(toolFrame.blocks.some((b) => b.kind === 'tool_call')).toBe(true)
    expect(toolFrame.blocks.some((b) => b.kind === 'tool_result')).toBe(true)
  })
})

describe('frame-projector: interrupted-turn content', () => {
  it('has turn_status with interrupted', () => {
    const { frames } = projectTimeline(loadFixture('interrupted-turn.ndjson'))
    const statusFrame = frames.find((f) =>
      f.sourceEvents.some((se) => se.eventKind === 'runtime.interrupted')
    )
    expect(statusFrame).toBeDefined()
    expect(statusFrame!.blocks[0]!.status).toBe('interrupted')
  })
})

describe('frame-projector: stale-generation content', () => {
  it('has session_status reflecting generation rotation', () => {
    const { frames } = projectTimeline(loadFixture('stale-generation.ndjson'))
    const sessionFrame = frames.find((f) => f.frameKind === 'session_status')!

    // After generation_auto_rotated + runtime.stale, session should show stale
    expect(sessionFrame.blocks[0]!.status).toBe('stale')
    // sourceEvents should include both session and runtime events
    expect(sessionFrame.sourceEvents.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// allUpdates tracking
// ---------------------------------------------------------------------------

describe('frame-projector: allUpdates', () => {
  it('captures all frame updates during projection', () => {
    const inputs = loadFixture('claude-prompt-response.ndjson')
    const { allUpdates } = projectTimeline(inputs)

    // Should have at least one update per input
    expect(allUpdates.length).toBeGreaterThanOrEqual(inputs.length)

    // Should have some creates
    const creates = allUpdates.filter((u) => u.action === 'create')
    expect(creates.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('frame-projector: edge cases', () => {
  it('empty input array produces empty frames', () => {
    const result = projectTimeline([])
    expect(result.frames.length).toBe(0)
    expect(result.state.highWaterHrcSeq).toBe(0)
    expect(result.state.nextFrameSeq).toBe(1)
  })
})
