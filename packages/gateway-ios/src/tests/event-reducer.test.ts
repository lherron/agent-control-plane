import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { TimelineFrame } from '../contracts.js'
import {
  type FrameUpdate,
  type ReducerState,
  createReducerState,
  reduce,
} from '../event-reducer.js'
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

/** Run a full fixture through the reducer and return all created frames. */
function runFixture(name: string): {
  frames: Map<string, TimelineFrame>
  updates: FrameUpdate[]
  state: ReducerState
} {
  const inputs = loadFixture(name)
  let state = createReducerState()
  const allUpdates: FrameUpdate[] = []

  for (const input of inputs) {
    const result = reduce(state, input)
    state = result.state
    allUpdates.push(...result.frameUpdates)
  }

  const frames = new Map<string, TimelineFrame>()
  for (const [key, fs] of state.frames) {
    frames.set(key, fs.frame)
  }

  return { frames, updates: allUpdates, state }
}

// ---------------------------------------------------------------------------
// Fixture playback tests
// ---------------------------------------------------------------------------

describe('event-reducer: fixture playback', () => {
  it('claude-prompt-response produces non-empty deterministic frames', () => {
    const { frames, updates } = runFixture('claude-prompt-response.ndjson')
    expect(frames.size).toBeGreaterThan(0)

    // Should have: session_status, turn_status, user_prompt, assistant_message
    const kinds = new Set([...frames.values()].map((f) => f.frameKind))
    expect(kinds.has('session_status')).toBe(true)
    expect(kinds.has('turn_status')).toBe(true)
    expect(kinds.has('user_prompt')).toBe(true)
    expect(kinds.has('assistant_message')).toBe(true)

    // Should have at least one create update
    const creates = updates.filter((u) => u.action === 'create')
    expect(creates.length).toBeGreaterThan(0)

    // Verify assistant message content
    const assistantFrame = [...frames.values()].find((f) => f.frameKind === 'assistant_message')!
    expect(assistantFrame.blocks.length).toBeGreaterThan(0)
    expect(assistantFrame.blocks[0]!.kind).toBe('markdown')
    expect(assistantFrame.blocks[0]!.text).toContain('Paris')

    // Verify user prompt content
    const userFrame = [...frames.values()].find((f) => f.frameKind === 'user_prompt')!
    expect(userFrame.blocks[0]!.text).toContain('capital of France')
  })

  it('claude-tool-use produces tool_call frame with call + result blocks', () => {
    const { frames } = runFixture('claude-tool-use.ndjson')
    expect(frames.size).toBeGreaterThan(0)

    // Should have a tool frame
    const toolFrame = [...frames.values()].find((f) => f.frameKind === 'tool_call')
    expect(toolFrame).toBeDefined()
    expect(toolFrame!.blocks.some((b) => b.kind === 'tool_call')).toBe(true)
    expect(toolFrame!.blocks.some((b) => b.kind === 'tool_result')).toBe(true)

    // tool_call block should have toolName and toolUseId
    const callBlock = toolFrame!.blocks.find((b) => b.kind === 'tool_call')!
    expect(callBlock.toolName).toBe('Read')
    expect(callBlock.toolUseId).toBe('tool-001')

    // tool_result block should have result text
    const resultBlock = toolFrame!.blocks.find((b) => b.kind === 'tool_result')!
    expect(resultBlock.text).toBe('Hello World')
    expect(resultBlock.status).toBe('success')
  })

  it('codex-prompt-response produces non-empty frames', () => {
    const { frames } = runFixture('codex-prompt-response.ndjson')
    expect(frames.size).toBeGreaterThan(0)

    const kinds = new Set([...frames.values()].map((f) => f.frameKind))
    expect(kinds.has('assistant_message')).toBe(true)
    expect(kinds.has('user_prompt')).toBe(true)
  })

  it('codex-tool-use produces tool_call frame', () => {
    const { frames } = runFixture('codex-tool-use.ndjson')
    expect(frames.size).toBeGreaterThan(0)

    const toolFrame = [...frames.values()].find((f) => f.frameKind === 'tool_call')
    expect(toolFrame).toBeDefined()
    expect(toolFrame!.blocks.some((b) => b.kind === 'tool_call')).toBe(true)
    expect(toolFrame!.blocks.some((b) => b.kind === 'tool_result')).toBe(true)
  })

  it('interrupted-turn produces turn_status with interrupted', () => {
    const { frames } = runFixture('interrupted-turn.ndjson')
    expect(frames.size).toBeGreaterThan(0)

    // Should have a turn_status frame with interrupted status
    const statusFrames = [...frames.values()].filter((f) => f.frameKind === 'turn_status')
    expect(statusFrames.length).toBeGreaterThan(0)

    // The latest turn_status should be interrupted
    const interrupted = statusFrames.find((f) =>
      f.sourceEvents.some((se) => se.eventKind === 'runtime.interrupted')
    )
    expect(interrupted).toBeDefined()
    expect(interrupted!.blocks[0]!.status).toBe('interrupted')
  })

  it('stale-generation produces session_status with stale', () => {
    const { frames } = runFixture('stale-generation.ndjson')
    expect(frames.size).toBeGreaterThan(0)

    // Should have a session_status frame reflecting staleness
    const sessionFrame = [...frames.values()].find((f) => f.frameKind === 'session_status')
    expect(sessionFrame).toBeDefined()
    // After generation rotation + runtime.stale, status should be stale
    expect(sessionFrame!.blocks[0]!.status).toBe('stale')
  })
})

// ---------------------------------------------------------------------------
// Determinism test
// ---------------------------------------------------------------------------

describe('event-reducer: determinism', () => {
  it('same fixture applied twice produces identical frame output', () => {
    const run1 = runFixture('claude-prompt-response.ndjson')
    const run2 = runFixture('claude-prompt-response.ndjson')

    const frames1 = [...run1.frames.values()].sort((a, b) => a.frameSeq - b.frameSeq)
    const frames2 = [...run2.frames.values()].sort((a, b) => a.frameSeq - b.frameSeq)

    expect(frames1.length).toBe(frames2.length)
    for (let i = 0; i < frames1.length; i++) {
      expect(frames1[i]!.frameId).toBe(frames2[i]!.frameId)
      expect(frames1[i]!.frameKind).toBe(frames2[i]!.frameKind)
      expect(frames1[i]!.lastHrcSeq).toBe(frames2[i]!.lastHrcSeq)
      expect(frames1[i]!.sourceEvents.length).toBe(frames2[i]!.sourceEvents.length)
      expect(frames1[i]!.blocks.length).toBe(frames2[i]!.blocks.length)
    }
  })
})

// ---------------------------------------------------------------------------
// Idempotency test
// ---------------------------------------------------------------------------

describe('event-reducer: idempotency', () => {
  it('applying the same event twice produces the same frame state (no duplicates)', () => {
    const inputs = loadFixture('claude-prompt-response.ndjson')
    let state = createReducerState()

    // Apply all events once
    for (const input of inputs) {
      const result = reduce(state, input)
      state = result.state
    }

    const frameCountAfterFirst = state.frames.size
    const firstPassFrames = new Map<string, TimelineFrame>()
    for (const [key, fs] of state.frames) {
      firstPassFrames.set(key, { ...fs.frame })
    }

    // Apply all events again (double delivery)
    for (const input of inputs) {
      const result = reduce(state, input)
      state = result.state
      // All updates should be noop
      for (const update of result.frameUpdates) {
        expect(update.action).toBe('noop')
      }
    }

    // Frame count should not change
    expect(state.frames.size).toBe(frameCountAfterFirst)

    // Each frame's sourceEvents should not have duplicated entries
    for (const [_key, fs] of state.frames) {
      const hrcSeqs = fs.frame.sourceEvents.map((se) => se.hrcSeq)
      const uniqueSeqs = new Set(hrcSeqs)
      expect(hrcSeqs.length).toBe(uniqueSeqs.size)
    }
  })
})

// ---------------------------------------------------------------------------
// Replay + live deduplication test
// ---------------------------------------------------------------------------

describe('event-reducer: replay then live', () => {
  it('applying replay then live with overlapping events deduplicates correctly', () => {
    const inputs = loadFixture('claude-prompt-response.ndjson')
    let state = createReducerState()

    // Simulate replay: apply first 5 events
    const replayInputs = inputs.slice(0, 5)
    for (const input of replayInputs) {
      reduce(state, input)
    }

    const _frameCountAfterReplay = state.frames.size

    // Simulate live: apply events 3-8 (overlap on events 3-5)
    const liveInputs = inputs.slice(2) // events at index 2,3,4,5,6,7
    for (const input of liveInputs) {
      const result = reduce(state, input)
      state = result.state
    }

    // No duplicated frames
    // Check each frame's sourceEvents don't have duplicate hrcSeqs
    for (const [_key, fs] of state.frames) {
      const hrcSeqs = fs.frame.sourceEvents.map((se) => se.hrcSeq)
      const uniqueSeqs = new Set(hrcSeqs)
      expect(hrcSeqs.length).toBe(uniqueSeqs.size)
    }
  })
})

// ---------------------------------------------------------------------------
// Coalescing test: multiple turn.message for same run+message+role
// ---------------------------------------------------------------------------

describe('event-reducer: coalescing', () => {
  it('multiple turn.message for same run+messageId+role merge into one frame', () => {
    let state = createReducerState()

    // Two turn.message events from the same run with the same messageId and role
    const event1: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 100,
        streamSeq: 100,
        ts: '2026-04-29T20:00:00.000Z',
        hostSessionId: 'host-coal',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-coal',
        runId: 'run-coal',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Part one of the response.' }],
          },
          messageId: 'msg-coal-001',
        },
      },
    }

    const event2: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 101,
        streamSeq: 101,
        ts: '2026-04-29T20:00:01.000Z',
        hostSessionId: 'host-coal',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-coal',
        runId: 'run-coal',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: ' Part two of the response.' }],
          },
          messageId: 'msg-coal-001',
        },
      },
    }

    // Apply first
    let result = reduce(state, event1)
    state = result.state
    expect(result.frameUpdates[0]!.action).toBe('create')

    // Apply second — same key, should update not create
    result = reduce(state, event2)
    state = result.state
    expect(result.frameUpdates[0]!.action).toBe('update')

    // Only one assistant_message frame
    const assistantFrames = [...state.frames.values()].filter(
      (fs) => fs.frame.frameKind === 'assistant_message'
    )
    expect(assistantFrames.length).toBe(1)

    // Frame should have 2 blocks (merged)
    const frame = assistantFrames[0]!.frame
    expect(frame.blocks.length).toBe(2)
    expect(frame.blocks[0]!.text).toBe('Part one of the response.')
    expect(frame.blocks[1]!.text).toBe(' Part two of the response.')

    // sourceEvents should have both citations
    expect(frame.sourceEvents.length).toBe(2)
    expect(frame.sourceEvents[0]!.hrcSeq).toBe(100)
    expect(frame.sourceEvents[1]!.hrcSeq).toBe(101)
  })
})

// ---------------------------------------------------------------------------
// Tool result first test
// ---------------------------------------------------------------------------

describe('event-reducer: tool result first', () => {
  it('turn.tool_result before turn.tool_call creates placeholder, then call fills it', () => {
    let state = createReducerState()

    // tool_result arrives first
    const resultEvent: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 200,
        streamSeq: 200,
        ts: '2026-04-29T21:00:00.000Z',
        hostSessionId: 'host-ooo',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-ooo',
        runId: 'run-ooo',
        category: 'turn',
        eventKind: 'turn.tool_result',
        replayed: false,
        payload: {
          type: 'tool_execution_end',
          toolUseId: 'tool-ooo-001',
          toolName: 'Write',
          result: {
            content: [{ type: 'text', text: 'File written successfully' }],
          },
          isError: false,
        },
      },
    }

    let result = reduce(state, resultEvent)
    state = result.state
    expect(result.frameUpdates[0]!.action).toBe('create')

    // Verify placeholder frame has tool_result but NOT tool_call block
    const key = 'run-ooo:tool:tool-ooo-001'
    const fs = state.frames.get(key)!
    expect(fs.frame.frameKind).toBe('tool_call')
    expect(fs.frame.blocks.some((b) => b.kind === 'tool_result')).toBe(true)
    expect(fs.frame.blocks.some((b) => b.kind === 'tool_call')).toBe(false)

    // Now tool_call arrives
    const callEvent: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 201,
        streamSeq: 201,
        ts: '2026-04-29T21:00:01.000Z',
        hostSessionId: 'host-ooo',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-ooo',
        runId: 'run-ooo',
        category: 'turn',
        eventKind: 'turn.tool_call',
        replayed: false,
        payload: {
          type: 'tool_execution_start',
          toolUseId: 'tool-ooo-001',
          toolName: 'Write',
          input: { file_path: '/tmp/test.txt', content: 'Hello' },
        },
      },
    }

    result = reduce(state, callEvent)
    state = result.state
    expect(result.frameUpdates[0]!.action).toBe('update')

    // Frame should now have BOTH blocks: tool_call prepended, tool_result after
    const updatedFs = state.frames.get(key)!
    expect(updatedFs.frame.blocks.length).toBe(2)
    expect(updatedFs.frame.blocks[0]!.kind).toBe('tool_call')
    expect(updatedFs.frame.blocks[1]!.kind).toBe('tool_result')
    expect(updatedFs.frame.blocks[0]!.toolName).toBe('Write')

    // sourceEvents: result(hrcSeq=200) + call(hrcSeq=201)
    expect(updatedFs.frame.sourceEvents.length).toBe(2)
    expect(updatedFs.frame.sourceEvents[0]!.eventKind).toBe('turn.tool_result')
    expect(updatedFs.frame.sourceEvents[1]!.eventKind).toBe('turn.tool_call')
  })
})

// ---------------------------------------------------------------------------
// Cross-run isolation test
// ---------------------------------------------------------------------------

describe('event-reducer: cross-run isolation', () => {
  it('turn.message from runA never coalesces with turn.message from runB', () => {
    const state = createReducerState()

    const eventA: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 300,
        streamSeq: 300,
        ts: '2026-04-29T22:00:00.000Z',
        hostSessionId: 'host-iso',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-iso',
        runId: 'run-A',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response from run A' }],
          },
          messageId: 'msg-iso-001',
        },
      },
    }

    const eventB: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 301,
        streamSeq: 301,
        ts: '2026-04-29T22:00:01.000Z',
        hostSessionId: 'host-iso',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-iso',
        runId: 'run-B',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response from run B' }],
          },
          messageId: 'msg-iso-001', // Same messageId but different runId
        },
      },
    }

    reduce(state, eventA)
    reduce(state, eventB)

    // Should have TWO separate assistant_message frames
    const assistantFrames = [...state.frames.values()].filter(
      (fs) => fs.frame.frameKind === 'assistant_message'
    )
    expect(assistantFrames.length).toBe(2)

    // Verify each has different content
    const texts = assistantFrames.map((fs) => fs.frame.blocks[0]!.text)
    expect(texts).toContain('Response from run A')
    expect(texts).toContain('Response from run B')
  })

  it('turn.message from same run but different roles are separate frames', () => {
    const state = createReducerState()

    const assistantEvent: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 400,
        streamSeq: 400,
        ts: '2026-04-29T23:00:00.000Z',
        hostSessionId: 'host-role',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-role',
        runId: 'run-role',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Assistant says hello' }],
          },
          messageId: 'msg-role-001',
        },
      },
    }

    const userLikeEvent: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 401,
        streamSeq: 401,
        ts: '2026-04-29T23:00:01.000Z',
        hostSessionId: 'host-role',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-role',
        runId: 'run-role',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'User says hello' }],
          },
          messageId: 'msg-role-001', // Same messageId but different role
        },
      },
    }

    reduce(state, assistantEvent)
    reduce(state, userLikeEvent)

    // Should have TWO separate frames because role differs
    const messageFrames = [...state.frames.values()].filter(
      (fs) => fs.frame.frameKind === 'assistant_message'
    )
    expect(messageFrames.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Source event preservation test
// ---------------------------------------------------------------------------

describe('event-reducer: source event preservation', () => {
  it('every frame.sourceEvents references canonical eventKind', () => {
    const { frames } = runFixture('claude-tool-use.ndjson')

    for (const frame of frames.values()) {
      for (const se of frame.sourceEvents) {
        // eventKind must be a canonical HRC eventKind (e.g., session.created, turn.message)
        expect(typeof se.eventKind).toBe('string')
        expect(se.eventKind.length).toBeGreaterThan(0)
        // Must contain a dot (category.action format)
        expect(se.eventKind).toContain('.')
      }
    }
  })

  it('category is preserved from HRC event (never renamed)', () => {
    const inputs = loadFixture('claude-tool-use.ndjson')
    const state = createReducerState()

    for (const input of inputs) {
      if (input.kind === 'event') {
        // Verify the event has a category
        expect(typeof input.event.category).toBe('string')
      }
      reduce(state, input)
    }

    // Check that tool frames have turn category events
    const toolFrame = [...state.frames.values()].find((fs) => fs.frame.frameKind === 'tool_call')
    expect(toolFrame).toBeDefined()
    // Source events should reference turn.tool_call and turn.tool_result
    const toolEventKinds = toolFrame!.frame.sourceEvents.map((se) => se.eventKind)
    expect(toolEventKinds).toContain('turn.tool_call')
    expect(toolEventKinds).toContain('turn.tool_result')
  })
})

// ---------------------------------------------------------------------------
// Coverage: every TimelineFrameKind has a producing path
// ---------------------------------------------------------------------------

describe('event-reducer: frame kind coverage', () => {
  it('session_status frame is produced', () => {
    const { frames } = runFixture('claude-prompt-response.ndjson')
    const has = [...frames.values()].some((f) => f.frameKind === 'session_status')
    expect(has).toBe(true)
  })

  it('turn_status frame is produced', () => {
    const { frames } = runFixture('claude-prompt-response.ndjson')
    const has = [...frames.values()].some((f) => f.frameKind === 'turn_status')
    expect(has).toBe(true)
  })

  it('user_prompt frame is produced', () => {
    const { frames } = runFixture('claude-prompt-response.ndjson')
    const has = [...frames.values()].some((f) => f.frameKind === 'user_prompt')
    expect(has).toBe(true)
  })

  it('assistant_message frame is produced', () => {
    const { frames } = runFixture('claude-prompt-response.ndjson')
    const has = [...frames.values()].some((f) => f.frameKind === 'assistant_message')
    expect(has).toBe(true)
  })

  it('tool_call frame is produced', () => {
    const { frames } = runFixture('claude-tool-use.ndjson')
    const has = [...frames.values()].some((f) => f.frameKind === 'tool_call')
    expect(has).toBe(true)
  })

  it('input_ack frame is produced from inflight events', () => {
    const state = createReducerState()
    const inflightEvent: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 500,
        streamSeq: 500,
        ts: '2026-04-29T23:30:00.000Z',
        hostSessionId: 'host-ack',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-ack',
        runId: 'run-ack',
        category: 'inflight',
        eventKind: 'inflight.accepted',
        replayed: false,
        payload: {
          prompt: 'test prompt',
          inputType: 'literal',
          pendingTurns: 0,
        },
      },
    }

    const result = reduce(state, inflightEvent)
    expect(result.frameUpdates[0]!.action).toBe('create')

    const inputAckFrame = [...result.state.frames.values()].find(
      (fs) => fs.frame.frameKind === 'input_ack'
    )
    expect(inputAckFrame).toBeDefined()
    expect(inputAckFrame!.frame.blocks[0]!.status).toBe('accepted')
  })
})

// ---------------------------------------------------------------------------
// Coverage: every TimelineBlockKind appears in at least one frame
// ---------------------------------------------------------------------------

describe('event-reducer: block kind coverage', () => {
  it('markdown block appears in assistant_message', () => {
    const { frames } = runFixture('claude-prompt-response.ndjson')
    const assistantFrame = [...frames.values()].find((f) => f.frameKind === 'assistant_message')!
    expect(assistantFrame.blocks.some((b) => b.kind === 'markdown')).toBe(true)
  })

  it('tool_call block appears in tool frame', () => {
    const { frames } = runFixture('claude-tool-use.ndjson')
    const toolFrame = [...frames.values()].find((f) => f.frameKind === 'tool_call')!
    expect(toolFrame.blocks.some((b) => b.kind === 'tool_call')).toBe(true)
  })

  it('tool_result block appears in tool frame', () => {
    const { frames } = runFixture('claude-tool-use.ndjson')
    const toolFrame = [...frames.values()].find((f) => f.frameKind === 'tool_call')!
    expect(toolFrame.blocks.some((b) => b.kind === 'tool_result')).toBe(true)
  })

  it('status block appears in turn_status frame', () => {
    const { frames } = runFixture('claude-prompt-response.ndjson')
    const statusFrame = [...frames.values()].find((f) => f.frameKind === 'turn_status')!
    expect(statusFrame.blocks.some((b) => b.kind === 'status')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// High-water tracking
// ---------------------------------------------------------------------------

describe('event-reducer: high-water tracking', () => {
  it('tracks highWaterHrcSeq correctly', () => {
    const { state } = runFixture('claude-prompt-response.ndjson')
    expect(state.highWaterHrcSeq).toBe(8) // 8 events in fixture
  })

  it('tracks nextFrameSeq monotonically', () => {
    const { state } = runFixture('claude-prompt-response.ndjson')
    expect(state.nextFrameSeq).toBeGreaterThan(1)
    // frameSeq of every frame should be < nextFrameSeq
    for (const fs of state.frames.values()) {
      expect(fs.frame.frameSeq).toBeLessThan(state.nextFrameSeq)
    }
  })
})

// ---------------------------------------------------------------------------
// Unknown event kinds are skipped (noop)
// ---------------------------------------------------------------------------

describe('event-reducer: unknown events', () => {
  it('unknown eventKind produces noop', () => {
    const state = createReducerState()
    const unknownEvent: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 999,
        streamSeq: 999,
        ts: '2026-04-29T23:59:00.000Z',
        hostSessionId: 'host-unk',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        category: 'launch',
        eventKind: 'launch.wrapper_started',
        replayed: false,
        payload: { wrapperPid: 12345 },
      },
    }

    const result = reduce(state, unknownEvent)
    expect(result.frameUpdates.length).toBe(1)
    expect(result.frameUpdates[0]!.action).toBe('noop')
  })
})

// ---------------------------------------------------------------------------
// Message inputs are handled (noop for MVP)
// ---------------------------------------------------------------------------

describe('event-reducer: message inputs', () => {
  it('hrcchat message input produces noop for MVP', () => {
    const state = createReducerState()
    const msgInput: ReducerInput = {
      kind: 'message',
      message: {
        messageSeq: 42,
        messageId: 'msg-chat-001',
        createdAt: '2026-04-29T23:59:00.000Z',
        kind: 'dm',
        phase: 'request',
        from: { kind: 'session', sessionRef: 'agent:cody:project:test/lane:main' },
        to: { kind: 'session', sessionRef: 'agent:larry:project:wrkq/lane:main' },
        rootMessageId: 'msg-chat-001',
        body: 'Hello!',
        bodyFormat: 'text/plain',
        execution: { state: 'not_applicable' },
      },
    }

    const result = reduce(state, msgInput)
    expect(result.frameUpdates.length).toBe(1)
    expect(result.frameUpdates[0]!.action).toBe('noop')
    expect(result.state.highWaterMessageSeq).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Assistant message fallback key (no messageId)
// ---------------------------------------------------------------------------

describe('event-reducer: assistant message fallback key', () => {
  it('uses runId+role+assistant_message when messageId is absent', () => {
    const state = createReducerState()

    const eventNoMsgId: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 600,
        streamSeq: 600,
        ts: '2026-04-29T23:45:00.000Z',
        hostSessionId: 'host-fb',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-fb',
        runId: 'run-fb',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response without messageId' }],
          },
          // No messageId
        },
      },
    }

    const result = reduce(state, eventNoMsgId)
    expect(result.frameUpdates[0]!.action).toBe('create')

    // Verify the frame key uses the fallback
    const expectedKey = 'run-fb:assistant:assistant_message'
    expect(state.frames.has(expectedKey)).toBe(true)
  })

  it('second message without messageId coalesces into fallback frame', () => {
    const state = createReducerState()

    const event1: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 700,
        streamSeq: 700,
        ts: '2026-04-29T23:46:00.000Z',
        hostSessionId: 'host-fb2',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-fb2',
        runId: 'run-fb2',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'First part' }],
          },
        },
      },
    }

    const event2: ReducerInput = {
      kind: 'event',
      event: {
        hrcSeq: 701,
        streamSeq: 701,
        ts: '2026-04-29T23:46:01.000Z',
        hostSessionId: 'host-fb2',
        scopeRef: 'agent:cody:project:test',
        laneRef: 'main',
        generation: 1,
        runtimeId: 'rt-fb2',
        runId: 'run-fb2',
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: ' second part' }],
          },
        },
      },
    }

    reduce(state, event1)
    const result2 = reduce(state, event2)
    expect(result2.frameUpdates[0]!.action).toBe('update')

    const assistantFrames = [...state.frames.values()].filter(
      (fs) => fs.frame.frameKind === 'assistant_message'
    )
    expect(assistantFrames.length).toBe(1)
    expect(assistantFrames[0]!.frame.blocks.length).toBe(2)
  })
})
