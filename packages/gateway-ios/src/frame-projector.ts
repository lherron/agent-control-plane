/**
 * Frame projector: sequences of ReducerInputs → final ordered timeline frames.
 *
 * Used by both snapshot construction and history paging. Takes a chronological
 * (oldest-first) sequence of ReducerInputs and produces a final ordered list
 * of TimelineFrames (oldest-first by frameSeq).
 *
 * Two entry points:
 * - projectTimeline(inputs)       — fresh projection from empty state
 * - projectIncremental(state, inputs) — continues from prior reducer state
 */

import type { TimelineFrame } from './contracts.js'
import { type FrameUpdate, type ReducerState, createReducerState, reduce } from './event-reducer.js'
import type { ReducerInput } from './types.js'

// ---------------------------------------------------------------------------
// Projection result
// ---------------------------------------------------------------------------

/** Result of projecting a sequence of inputs through the reducer. */
export type ProjectionResult = {
  /** Final ordered frames, oldest-first (by frameSeq). */
  frames: TimelineFrame[]
  /** All frame updates produced during projection (in order). */
  allUpdates: FrameUpdate[]
  /** Reducer state after all inputs — can be passed to projectIncremental. */
  state: ReducerState
}

// ---------------------------------------------------------------------------
// Internal: extract ordered frames from state
// ---------------------------------------------------------------------------

function extractFrames(state: ReducerState): TimelineFrame[] {
  const frames: TimelineFrame[] = []
  for (const fs of state.frames.values()) {
    frames.push(fs.frame)
  }
  frames.sort((a, b) => a.frameSeq - b.frameSeq)
  return frames
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Project a chronological (oldest-first) sequence of ReducerInputs
 * into an ordered list of TimelineFrames from a fresh empty state.
 */
export function projectTimeline(inputs: ReducerInput[]): ProjectionResult {
  return projectIncremental(createReducerState(), inputs)
}

/**
 * Continue projection from a prior reducer state.
 */
export function projectIncremental(state: ReducerState, inputs: ReducerInput[]): ProjectionResult {
  const allUpdates: FrameUpdate[] = []

  for (const input of inputs) {
    const result = reduce(state, input)
    allUpdates.push(...result.frameUpdates)
  }

  return { frames: extractFrames(state), allUpdates, state }
}
