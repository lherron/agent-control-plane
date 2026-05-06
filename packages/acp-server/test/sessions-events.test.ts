import { describe, expect, test } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'

import { handleSessionEvents } from '../src/handlers/sessions-events.js'

function createLifecycleEvent(overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-05-06T00:00:00.000Z',
    hostSessionId: 'hsid-events-001',
    scopeRef: 'agent:larry:project:agent-spaces',
    laneRef: 'main',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.message',
    payload: { type: 'message_end' },
    ...overrides,
  }
}

function createContext(
  path: string,
  hrcClient: {
    watch: (options?: Record<string, unknown>) => AsyncIterable<HrcLifecycleEvent>
  },
  signal?: AbortSignal
) {
  return {
    request: new Request(`http://acp.test${path}`, { signal }),
    url: new URL(`http://acp.test${path}`),
    params: { sessionId: 'hsid-events-001' },
    deps: { hrcClient },
  } as Parameters<typeof handleSessionEvents>[0]
}

describe('GET /v1/sessions/:sessionId/events', () => {
  test('passes follow, runId, generation, fromSeq, hostSessionId, and signal to HRC watch', async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const hrcClient = {
      watch(options?: Record<string, unknown>) {
        calls.push(options)
        return (async function* () {
          yield createLifecycleEvent({
            hrcSeq: 41,
            hostSessionId: 'hsid-events-001',
            runId: 'hrc-run-001',
            generation: 2,
          })
        })()
      },
    }

    const response = await handleSessionEvents(
      createContext(
        '/v1/sessions/hsid-events-001/events?follow=false&runId=hrc-run-001&generation=2&fromSeq=41',
        hrcClient
      )
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"runId":"hrc-run-001"')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(
      expect.objectContaining({
        follow: false,
        runId: 'hrc-run-001',
        generation: 2,
        fromSeq: 41,
        hostSessionId: 'hsid-events-001',
        signal: expect.any(AbortSignal),
      })
    )
  })

  test('defaults follow=true and aborts the upstream watch on stream cancel', async () => {
    let watchSignal: AbortSignal | undefined
    let returned = false
    const hrcClient = {
      watch(options?: Record<string, unknown>) {
        watchSignal = options?.['signal'] as AbortSignal | undefined
        return (async function* () {
          try {
            yield createLifecycleEvent()
            await new Promise<void>((resolve) => {
              watchSignal?.addEventListener('abort', () => resolve(), { once: true })
            })
          } finally {
            returned = true
          }
        })()
      },
    }

    const response = await handleSessionEvents(
      createContext('/v1/sessions/hsid-events-001/events', hrcClient)
    )
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()

    const first = await reader?.read()
    expect(first?.done).toBe(false)
    expect(new TextDecoder().decode(first?.value)).toContain('"hostSessionId":"hsid-events-001"')

    await reader?.cancel()
    await Bun.sleep(0)

    expect(watchSignal?.aborted).toBe(true)
    expect(returned).toBe(true)
  })
})
