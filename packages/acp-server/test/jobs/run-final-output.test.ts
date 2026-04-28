import { describe, expect, test } from 'bun:test'

import type { UnifiedSessionEvent } from 'spaces-runtime'

import type { StoredRun } from '../../src/domain/run-store.js'
import {
  type HrcEventReaders,
  type RawRunEventRecord,
  type RunFinalOutputDeps,
  getRunFinalAssistantText,
} from '../../src/jobs/run-final-output.js'

// ---------------------------------------------------------------------------
// Helpers: minimal StoredRun factory
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: 'run-1',
    scopeRef: 'agent:larry@project:demo',
    laneRef: 'main',
    actor: { kind: 'system', id: 'test' },
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeDeps(run: StoredRun | undefined, hrcDbPath = ':memory:'): RunFinalOutputDeps {
  return {
    getRun: () => run,
    hrcDbPath,
  }
}

// ---------------------------------------------------------------------------
// Fake readers
// ---------------------------------------------------------------------------

function fakeReaders(overrides: Partial<HrcEventReaders> = {}): HrcEventReaders {
  return {
    listRawRunEvents: () => [],
    toUnifiedAssistantMessageEndFromRawEvents: () => undefined,
    readLatestAssistantMessageSeq: () => 0,
    readAssistantMessageAfterSeq: () => undefined,
    ...overrides,
  }
}

function makeMessageEndEvent(text: string): UnifiedSessionEvent {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getRunFinalAssistantText', () => {
  // -----------------------------------------------------------------------
  // Headless path (hrcRunId)
  // -----------------------------------------------------------------------

  test('headless: extracts text from raw run events via hrcRunId', () => {
    const run = makeRun({ hrcRunId: 'hrc-run-42' })
    const deps = makeDeps(run, '/fake/hrc.db')

    const readers = fakeReaders({
      listRawRunEvents: (dbPath, runId) => {
        expect(dbPath).toBe('/fake/hrc.db')
        expect(runId).toBe('hrc-run-42')
        return [
          {
            eventKind: 'message_end',
            eventJson: {
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'headless reply' }],
              },
            },
          },
        ] satisfies RawRunEventRecord[]
      },
      toUnifiedAssistantMessageEndFromRawEvents: () => makeMessageEndEvent('headless reply'),
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBe('headless reply')
  })

  test('headless: returns undefined when no events exist', () => {
    const run = makeRun({ hrcRunId: 'hrc-run-empty' })
    const deps = makeDeps(run)

    const readers = fakeReaders({
      listRawRunEvents: () => [],
      toUnifiedAssistantMessageEndFromRawEvents: () => undefined,
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Interactive/tmux path (hostSessionId)
  // -----------------------------------------------------------------------

  test('interactive: extracts text from hrc_events via hostSessionId', () => {
    const run = makeRun({
      hostSessionId: 'hsid-789',
      generation: 5,
    })
    const deps = makeDeps(run, '/fake/hrc.db')

    const readers = fakeReaders({
      readLatestAssistantMessageSeq: (dbPath, input) => {
        expect(dbPath).toBe('/fake/hrc.db')
        expect(input.hostSessionId).toBe('hsid-789')
        expect(input.sessionRef.scopeRef).toBe('agent:larry@project:demo')
        expect(input.sessionRef.laneRef).toBe('main')
        return 10
      },
      readAssistantMessageAfterSeq: (options) => {
        expect(options.hrcDbPath).toBe('/fake/hrc.db')
        expect(options.hostSessionId).toBe('hsid-789')
        expect(options.afterHrcSeq).toBe(9) // latestSeq - 1
        return makeMessageEndEvent('interactive reply')
      },
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBe('interactive reply')
  })

  test('interactive: returns undefined when latestSeq is 0 (no messages)', () => {
    const run = makeRun({
      hostSessionId: 'hsid-empty',
      generation: 1,
    })
    const deps = makeDeps(run)

    const readers = fakeReaders({
      readLatestAssistantMessageSeq: () => 0,
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBeUndefined()
  })

  test('interactive: returns undefined when readAssistantMessageAfterSeq returns undefined', () => {
    const run = makeRun({
      hostSessionId: 'hsid-gap',
      generation: 2,
    })
    const deps = makeDeps(run)

    const readers = fakeReaders({
      readLatestAssistantMessageSeq: () => 5,
      readAssistantMessageAfterSeq: () => undefined,
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    expect(result).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test('returns undefined when run is not found', () => {
    const deps = makeDeps(undefined)
    const result = getRunFinalAssistantText(deps, 'nonexistent')
    expect(result).toBeUndefined()
  })

  test('returns undefined when run has neither hrcRunId nor hostSessionId', () => {
    const run = makeRun() // no hrcRunId, no hostSessionId
    const deps = makeDeps(run)
    const result = getRunFinalAssistantText(deps, 'run-1', fakeReaders())
    expect(result).toBeUndefined()
  })

  test('headless path takes priority when both hrcRunId and hostSessionId present', () => {
    const run = makeRun({
      hrcRunId: 'hrc-run-priority',
      hostSessionId: 'hsid-also-present',
    })
    const deps = makeDeps(run, '/fake/hrc.db')

    let headlessCalled = false
    let interactiveCalled = false

    const readers = fakeReaders({
      listRawRunEvents: () => {
        headlessCalled = true
        return []
      },
      toUnifiedAssistantMessageEndFromRawEvents: () => makeMessageEndEvent('from headless'),
      readLatestAssistantMessageSeq: () => {
        interactiveCalled = true
        return 10
      },
    })

    getRunFinalAssistantText(deps, 'run-1', readers)
    expect(headlessCalled).toBe(true)
    expect(interactiveCalled).toBe(false)
  })

  test('message_end with empty text returns undefined', () => {
    const run = makeRun({ hrcRunId: 'hrc-run-empty-text' })
    const deps = makeDeps(run)

    // visible-assistant-messages.ts returns undefined for empty text
    const emptyEvent: UnifiedSessionEvent = {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    }

    const readers = fakeReaders({
      listRawRunEvents: () => [],
      toUnifiedAssistantMessageEndFromRawEvents: () => emptyEvent,
    })

    const result = getRunFinalAssistantText(deps, 'run-1', readers)
    // toCompletedVisibleAssistantMessage returns undefined for whitespace-only text
    expect(result).toBeUndefined()
  })
})
