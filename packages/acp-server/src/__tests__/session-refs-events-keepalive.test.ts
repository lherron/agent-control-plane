import { afterEach, describe, expect, test } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AcpHrcClient } from '../index.js'

const EVENTS_PATH = '/v1/session-refs/events'
const SESSION_REF = 'agent:larry:project:agent-spaces/lane:main'

const textDecoder = new TextDecoder()

let originalSetInterval: typeof globalThis.setInterval
let originalClearInterval: typeof globalThis.clearInterval

afterEach(() => {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
})

function createHrcClientDouble(watch: AcpHrcClient['watch']): AcpHrcClient {
  return {
    watch,
  } as AcpHrcClient
}

function neverYieldingEvents(signal?: AbortSignal): AsyncIterable<HrcLifecycleEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return { done: true, value: undefined }
        },
        async return() {
          return { done: true, value: undefined }
        },
      } as AsyncIterator<HrcLifecycleEvent>
    },
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await Promise.race([
    reader.read(),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`timed out waiting ${timeoutMs}ms for an SSE keepalive chunk`)
    }),
  ])
}

describe('GET /v1/session-refs/events keepalive', () => {
  test('emits blank-line keepalive chunks while HRC watch is idle and clears the interval on abort', async () => {
    originalSetInterval = globalThis.setInterval
    originalClearInterval = globalThis.clearInterval

    const activeIntervals = new Set<ReturnType<typeof setInterval>>()
    const intervalDelays: number[] = []

    globalThis.setInterval = ((handler, timeout, ...args) => {
      const interval = originalSetInterval(handler, timeout, ...args)
      activeIntervals.add(interval)
      if (typeof timeout === 'number') {
        intervalDelays.push(timeout)
      }
      return interval
    }) as typeof globalThis.setInterval

    globalThis.clearInterval = ((interval) => {
      activeIntervals.delete(interval)
      return originalClearInterval(interval)
    }) as typeof globalThis.clearInterval

    const hrcClient = createHrcClientDouble((options) =>
      neverYieldingEvents(options?.signal as AbortSignal | undefined)
    )

    await withWiredServer(
      async (fixture) => {
        const abortController = new AbortController()
        const response = await fixture.handler(
          new Request(
            `http://acp.test${EVENTS_PATH}?sessionRef=${encodeURIComponent(
              SESSION_REF
            )}&follow=true`,
            { method: 'GET', signal: abortController.signal }
          )
        )

        expect(response.status).toBe(200)
        const reader = response.body?.getReader()
        expect(reader).toBeDefined()

        try {
          const first = await readWithTimeout(
            reader as ReadableStreamDefaultReader<Uint8Array>,
            6100
          )
          expect(first.done).toBe(false)
          expect(textDecoder.decode(first.value)).toBe('\n')
          expect(intervalDelays.some((delay) => delay <= 5000)).toBe(true)
        } finally {
          abortController.abort()
          await reader?.cancel()
          await Bun.sleep(0)
        }

        expect(activeIntervals.size).toBe(0)
      },
      { hrcClient }
    )
  }, 8000)
})
