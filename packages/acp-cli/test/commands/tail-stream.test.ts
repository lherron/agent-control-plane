import { describe, expect, test } from 'bun:test'

import { runTailCommand } from '../../src/commands/tail.js'
import { createFetchQueue } from '../cli-test-helpers.js'

describe('acp tail — incremental streaming', () => {
  test('--json collects all events from the NDJSON stream', async () => {
    const events = [
      { hrcSeq: 1, eventKind: 'turn.start', hostSessionId: 'hsid-1', ts: '2024-01-01T00:00:00Z' },
      { hrcSeq: 2, eventKind: 'turn.message', hostSessionId: 'hsid-1', ts: '2024-01-01T00:00:01Z' },
      { hrcSeq: 3, eventKind: 'turn.end', hostSessionId: 'hsid-1', ts: '2024-01-01T00:00:02Z' },
    ]

    const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

    const queue = createFetchQueue([
      {
        text: ndjson,
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-1/events')
          expect(request.method).toBe('GET')
        },
      },
    ])

    const output = await runTailCommand(['--session', 'hsid-1', '--json'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output.format).toBe('json')
    expect(output).toMatchObject({
      body: [
        { hrcSeq: 1, eventKind: 'turn.start' },
        { hrcSeq: 2, eventKind: 'turn.message' },
        { hrcSeq: 3, eventKind: 'turn.end' },
      ],
    })
  })

  test('--table renders events in table format', async () => {
    const events = [{ hrcSeq: 10, eventKind: 'turn.message', hostSessionId: 'hsid-2', ts: 'T1' }]
    const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

    const queue = createFetchQueue([
      {
        text: ndjson,
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-2/events')
        },
      },
    ])

    const output = await runTailCommand(['--session', 'hsid-2', '--table'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output.format).toBe('text')
    if (output.format === 'text') {
      expect(output.text).toContain('Seq')
      expect(output.text).toContain('Kind')
      expect(output.text).toContain('10')
      expect(output.text).toContain('turn.message')
    }
  })

  test('--from-seq passes fromSeq query parameter', async () => {
    const queue = createFetchQueue([
      {
        text: `${JSON.stringify({ hrcSeq: 50 })}\n`,
        assert(request) {
          const url = new URL(request.url)
          expect(url.pathname).toBe('/v1/sessions/hsid-3/events')
          expect(url.searchParams.get('fromSeq')).toBe('42')
        },
      },
    ])

    await runTailCommand(['--session', 'hsid-3', '--from-seq', '42', '--json'], {
      fetchImpl: queue.fetchImpl,
    })
  })

  test('streaming mode prints records incrementally (before stream closes)', async () => {
    // Simulate a streaming response using a ReadableStream that emits
    // lines over time.  We capture stdout writes to verify records are
    // emitted before the stream ends.
    const encoder = new TextEncoder()
    const writtenLines: string[] = []
    let streamClosed = false

    const line1 = `${JSON.stringify({ hrcSeq: 1, eventKind: 'turn.start' })}\n`
    const line2 = `${JSON.stringify({ hrcSeq: 2, eventKind: 'turn.end' })}\n`

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(line1))
        // Small delay to simulate network latency
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.enqueue(encoder.encode(line2))
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.close()
        streamClosed = true
      },
    })

    const mockFetch = async (
      _input: Request | string | URL,
      _init?: RequestInit
    ): Promise<Response> => {
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }

    // Intercept stdout to capture incremental writes
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
      if (typeof chunk === 'string') {
        writtenLines.push(chunk.trim())
      }
      const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
      callback?.()
      return true
    }) as typeof process.stdout.write

    try {
      await runTailCommand(['--session', 'hsid-stream'], { fetchImpl: mockFetch })
    } finally {
      process.stdout.write = originalWrite
    }

    // Both records should have been written
    expect(writtenLines.length).toBeGreaterThanOrEqual(2)
    expect(writtenLines[0]).toContain('"hrcSeq":1')
    expect(writtenLines[1]).toContain('"hrcSeq":2')
    // And the stream should have been fully consumed
    expect(streamClosed).toBe(true)
  })

  test('HTTP error is raised as AcpClientHttpError', async () => {
    const queue = createFetchQueue([
      {
        status: 404,
        body: { error: { code: 'not_found', message: 'session not found' } },
        assert() {},
      },
    ])

    await expect(
      runTailCommand(['--session', 'missing-session', '--json'], { fetchImpl: queue.fetchImpl })
    ).rejects.toThrow('session not found')
  })
})
