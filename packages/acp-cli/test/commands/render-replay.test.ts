import { describe, expect, test } from 'bun:test'

import { runRenderCommand } from '../../src/commands/render.js'
import { createFetchQueue } from '../cli-test-helpers.js'

describe('acp render — replay-backed and capture modes', () => {
  test('default mode (replay) reduces multi-event stream into rendered view', async () => {
    const events = [
      { hrcSeq: 1, eventKind: 'turn.start', text: 'Hello ' },
      { hrcSeq: 2, eventKind: 'turn.message', text: 'world' },
      { hrcSeq: 3, eventKind: 'turn.end' },
    ]
    const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

    const queue = createFetchQueue([
      {
        text: ndjson,
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-render/events')
          expect(request.method).toBe('GET')
        },
      },
    ])

    const output = await runRenderCommand(['--session', 'hsid-render'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output.format).toBe('json')
    expect(output).toMatchObject({
      body: {
        sessionId: 'hsid-render',
        source: 'replay',
        frame: {
          kind: 'replay',
          text: 'Hello world',
          eventCount: 3,
          lastSeq: 3,
        },
      },
    })
  })

  test('replay mode extracts text from content.text field', async () => {
    const events = [{ hrcSeq: 1, eventKind: 'turn.message', content: { text: 'from content' } }]
    const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

    const queue = createFetchQueue([
      {
        text: ndjson,
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-content/events')
        },
      },
    ])

    const output = await runRenderCommand(['--session', 'hsid-content'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output).toMatchObject({
      body: {
        source: 'replay',
        frame: { kind: 'replay', text: 'from content', eventCount: 1 },
      },
    })
  })

  test('replay mode with --table returns text format', async () => {
    const events = [{ hrcSeq: 1, eventKind: 'turn.message', text: 'table text' }]
    const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

    const queue = createFetchQueue([
      {
        text: ndjson,
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-table/events')
        },
      },
    ])

    const output = await runRenderCommand(['--session', 'hsid-table', '--table'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output.format).toBe('text')
    if (output.format === 'text') {
      expect(output.text).toBe('table text')
    }
  })

  test('--source capture fetches from /capture endpoint', async () => {
    const queue = createFetchQueue([
      {
        body: { text: 'captured pane output' },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-cap/capture')
          expect(request.method).toBe('GET')
        },
      },
    ])

    const output = await runRenderCommand(['--session', 'hsid-cap', '--source', 'capture'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output.format).toBe('json')
    expect(output).toMatchObject({
      body: {
        sessionId: 'hsid-cap',
        source: 'capture',
        frame: {
          kind: 'capture-snapshot',
          text: 'captured pane output',
        },
      },
    })
  })

  test('--source capture with --table returns text format', async () => {
    const queue = createFetchQueue([
      {
        body: { text: 'snapshot text' },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-snp/capture')
        },
      },
    ])

    const output = await runRenderCommand(
      ['--session', 'hsid-snp', '--source', 'capture', '--table'],
      { fetchImpl: queue.fetchImpl }
    )

    expect(output.format).toBe('text')
    if (output.format === 'text') {
      expect(output.text).toBe('snapshot text')
    }
  })

  test('invalid --source value throws usage error', async () => {
    await expect(
      runRenderCommand(['--session', 'hsid-bad', '--source', 'invalid'], {})
    ).rejects.toThrow('--source must be "replay" or "capture"')
  })

  test('replay mode handles events with no text content', async () => {
    const events = [
      { hrcSeq: 1, eventKind: 'session.start' },
      { hrcSeq: 2, eventKind: 'turn.message', text: 'only text' },
      { hrcSeq: 3, eventKind: 'session.end' },
    ]
    const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

    const queue = createFetchQueue([
      {
        text: ndjson,
        assert() {},
      },
    ])

    const output = await runRenderCommand(['--session', 'hsid-mixed'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output).toMatchObject({
      body: {
        source: 'replay',
        frame: { kind: 'replay', text: 'only text', eventCount: 3, lastSeq: 3 },
      },
    })
  })

  test('replay mode with empty event stream produces empty text', async () => {
    const queue = createFetchQueue([
      {
        text: '',
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-empty/events')
        },
      },
    ])

    const output = await runRenderCommand(['--session', 'hsid-empty'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output).toMatchObject({
      body: {
        source: 'replay',
        frame: { kind: 'replay', text: '', eventCount: 0, lastSeq: null },
      },
    })
  })
})
