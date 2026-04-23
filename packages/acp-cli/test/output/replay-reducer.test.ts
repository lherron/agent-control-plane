import { describe, expect, test } from 'bun:test'

import {
  emptyView,
  foldEvent,
  parseNdjsonLine,
  parseNdjsonText,
  reduceEventStream,
  reduceEvents,
  streamNdjsonEvents,
} from '../../src/output/replay-reducer.js'

describe('replay-reducer — NDJSON parsing', () => {
  test('parseNdjsonLine parses a single JSON object', () => {
    const event = parseNdjsonLine('{"hrcSeq":1,"eventKind":"turn.start"}')
    expect(event).toEqual({ hrcSeq: 1, eventKind: 'turn.start' })
  })

  test('parseNdjsonText parses multi-line NDJSON text', () => {
    const text = [
      JSON.stringify({ hrcSeq: 1 }),
      JSON.stringify({ hrcSeq: 2 }),
      '',
      JSON.stringify({ hrcSeq: 3 }),
      '',
    ].join('\n')

    const events = parseNdjsonText(text)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e['hrcSeq'])).toEqual([1, 2, 3])
  })

  test('parseNdjsonText handles empty input', () => {
    expect(parseNdjsonText('')).toEqual([])
    expect(parseNdjsonText('  \n  \n')).toEqual([])
  })
})

describe('replay-reducer — fold / reduce', () => {
  test('emptyView returns a blank slate', () => {
    const view = emptyView()
    expect(view.text).toBe('')
    expect(view.eventCount).toBe(0)
    expect(view.lastSeq).toBeUndefined()
  })

  test('foldEvent concatenates text from event.text', () => {
    let view = emptyView()
    view = foldEvent(view, { hrcSeq: 1, text: 'Hello ' })
    view = foldEvent(view, { hrcSeq: 2, text: 'world' })
    expect(view.text).toBe('Hello world')
    expect(view.eventCount).toBe(2)
    expect(view.lastSeq).toBe(2)
  })

  test('foldEvent concatenates text from event.content.text', () => {
    let view = emptyView()
    view = foldEvent(view, { hrcSeq: 1, content: { text: 'nested ' } })
    view = foldEvent(view, { hrcSeq: 2, content: { text: 'content' } })
    expect(view.text).toBe('nested content')
  })

  test('foldEvent prefers content.text over event.text', () => {
    let view = emptyView()
    view = foldEvent(view, { hrcSeq: 1, text: 'top-level', content: { text: 'nested' } })
    expect(view.text).toBe('nested')
  })

  test('foldEvent skips events without text content', () => {
    let view = emptyView()
    view = foldEvent(view, { hrcSeq: 1, eventKind: 'session.start' })
    view = foldEvent(view, { hrcSeq: 2, text: 'data' })
    view = foldEvent(view, { hrcSeq: 3, eventKind: 'session.end' })
    expect(view.text).toBe('data')
    expect(view.eventCount).toBe(3)
    expect(view.lastSeq).toBe(3)
  })

  test('reduceEvents reduces array to final view', () => {
    const events = [
      { hrcSeq: 10, text: 'A' },
      { hrcSeq: 20, eventKind: 'control' },
      { hrcSeq: 30, text: 'B' },
    ]

    const view = reduceEvents(events)
    expect(view.text).toBe('AB')
    expect(view.eventCount).toBe(3)
    expect(view.lastSeq).toBe(30)
  })

  test('reduceEvents with empty array returns empty view', () => {
    const view = reduceEvents([])
    expect(view.text).toBe('')
    expect(view.eventCount).toBe(0)
    expect(view.lastSeq).toBeUndefined()
  })
})

describe('replay-reducer — streaming', () => {
  test('streamNdjsonEvents yields events from a ReadableStream', async () => {
    const lines = [
      `${JSON.stringify({ hrcSeq: 1, eventKind: 'a' })}\n`,
      `${JSON.stringify({ hrcSeq: 2, eventKind: 'b' })}\n`,
    ]
    const blob = lines.join('')
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(blob))
        controller.close()
      },
    })

    const events: Array<Record<string, unknown>> = []
    for await (const event of streamNdjsonEvents(stream)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ hrcSeq: 1 })
    expect(events[1]).toMatchObject({ hrcSeq: 2 })
  })

  test('streamNdjsonEvents handles chunked delivery', async () => {
    // Simulate a line being split across two chunks
    const encoder = new TextEncoder()
    const fullLine = `${JSON.stringify({ hrcSeq: 1, eventKind: 'split' })}\n`
    const part1 = fullLine.slice(0, 10)
    const part2 = fullLine.slice(10)

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(part1))
        await new Promise((resolve) => setTimeout(resolve, 5))
        controller.enqueue(encoder.encode(part2))
        controller.close()
      },
    })

    const events: Array<Record<string, unknown>> = []
    for await (const event of streamNdjsonEvents(stream)) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ hrcSeq: 1, eventKind: 'split' })
  })

  test('streamNdjsonEvents handles trailing data without newline', async () => {
    const encoder = new TextEncoder()
    // No trailing newline
    const blob = JSON.stringify({ hrcSeq: 99 })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(blob))
        controller.close()
      },
    })

    const events: Array<Record<string, unknown>> = []
    for await (const event of streamNdjsonEvents(stream)) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ hrcSeq: 99 })
  })

  test('reduceEventStream folds events from async iterable', async () => {
    const encoder = new TextEncoder()
    const lines = [
      `${JSON.stringify({ hrcSeq: 1, text: 'alpha ' })}\n`,
      `${JSON.stringify({ hrcSeq: 2, text: 'beta' })}\n`,
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines.join('')))
        controller.close()
      },
    })

    const view = await reduceEventStream(streamNdjsonEvents(stream))
    expect(view.text).toBe('alpha beta')
    expect(view.eventCount).toBe(2)
    expect(view.lastSeq).toBe(2)
  })
})
