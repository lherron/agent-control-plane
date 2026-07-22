import { describe, expect, test } from 'bun:test'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import type { AcpHrcClient } from '../src/deps.js'
import { withWiredServer } from './fixtures/wired-server.js'

const NOW = '2026-05-18T17:00:00.000Z'
const HOST_SESSION_ID = 'hsid-mobile-scoped'
const OTHER_HOST_SESSION_ID = 'hsid-other'

const SESSION: HrcSessionRecord = {
  hostSessionId: HOST_SESSION_ID,
  scopeRef: 'agent:cody:project:agent-spaces',
  laneRef: 'main',
  generation: 2,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  ancestorScopeRefs: [],
}

const OTHER_SESSION: HrcSessionRecord = {
  hostSessionId: OTHER_HOST_SESSION_ID,
  scopeRef: 'agent:cody:project:other',
  laneRef: 'main',
  generation: 1,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  ancestorScopeRefs: [],
}

const RUNTIME: HrcRuntimeSnapshot = {
  runtimeId: 'rt-mobile-scoped',
  hostSessionId: HOST_SESSION_ID,
  scopeRef: SESSION.scopeRef,
  laneRef: SESSION.laneRef,
  generation: SESSION.generation,
  transport: 'tmux',
  harness: 'codex',
  provider: 'openai',
  status: 'active',
  tmuxJson: { paneId: 'pane-1' },
  wrapperPid: 111,
  childPid: 222,
  supportsInflightInput: true,
  adopted: false,
  activeRunId: 'run-mobile-scoped',
  createdAt: NOW,
  updatedAt: NOW,
}

type DeliverCall = {
  selectorSessionRef: string
  text: string
  enter?: boolean | undefined
}

function makeHrcClient(input: {
  sessions: HrcSessionRecord[]
  runtimes?: HrcRuntimeSnapshot[]
  onDeliver?: ((call: DeliverCall) => void) | undefined
  onInterrupt?: ((runtimeId: string) => void) | undefined
  deliverThrows?: Error | undefined
  interruptThrows?: Error | undefined
}): AcpHrcClient {
  return {
    listSessions: async () => input.sessions,
    listRuntimes: async ({ hostSessionId }: { hostSessionId?: string | undefined } = {}) =>
      (input.runtimes ?? []).filter(
        (rt) => hostSessionId === undefined || rt.hostSessionId === hostSessionId
      ),
    deliverLiteralBySelector: async (request: {
      selector: { sessionRef: string }
      text: string
      enter?: boolean | undefined
    }) => {
      if (input.deliverThrows !== undefined) throw input.deliverThrows
      input.onDeliver?.({
        selectorSessionRef: request.selector.sessionRef,
        text: request.text,
        enter: request.enter,
      })
      return {
        delivered: true as const,
        sessionRef: request.selector.sessionRef,
        hostSessionId: HOST_SESSION_ID,
        generation: SESSION.generation,
      }
    },
    interrupt: async (runtimeId: string) => {
      if (input.interruptThrows !== undefined) throw input.interruptThrows
      input.onInterrupt?.(runtimeId)
      return { interrupted: true as const, runtimeId }
    },
  } as unknown as AcpHrcClient
}

describe('POST /v1/mobile/sessions/:hostSessionId/input', () => {
  test('extracts hostSessionId from path and forwards sessionRef to deliverLiteralBySelector', async () => {
    const calls: DeliverCall[] = []
    const hrcClient = makeHrcClient({
      sessions: [OTHER_SESSION, SESSION],
      runtimes: [RUNTIME],
      onDeliver: (call) => calls.push(call),
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/input`,
          body: { clientInputId: 'cli-1', text: 'hello world' },
        })
        expect(response.status).toBe(200)
        const body = await json<{ ok: boolean; clientInputId: string }>(response)
        expect(body.ok).toBe(true)
        expect(body.clientInputId).toBe('cli-1')
        expect(calls).toEqual([
          {
            selectorSessionRef: 'agent:cody:project:agent-spaces/lane:main',
            text: 'hello world',
            enter: true,
          },
        ])
      },
      { hrcClient }
    )
  })

  test('returns 422 when delivery fails', async () => {
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      deliverThrows: new Error('boom'),
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/input`,
          body: { clientInputId: 'cli-2', text: 'hello' },
        })
        expect(response.status).toBe(422)
        const body = await json<{ ok: boolean; code: string; clientInputId: string }>(response)
        expect(body.ok).toBe(false)
        expect(body.code).toBe('input_failed')
        expect(body.clientInputId).toBe('cli-2')
      },
      { hrcClient }
    )
  })

  test('returns 422 when session not found for unknown hostSessionId', async () => {
    const hrcClient = makeHrcClient({
      sessions: [OTHER_SESSION],
      runtimes: [],
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/sessions/hsid-missing/input',
          body: { clientInputId: 'cli-3', text: 'hello' },
        })
        expect(response.status).toBe(422)
        const body = await json<{ ok: boolean; code: string }>(response)
        expect(body.ok).toBe(false)
        expect(body.code).toBe('input_failed')
      },
      { hrcClient }
    )
  })

  test('refuses remote projection literal input before invoking local HRC methods', async () => {
    let listSessionsCalls = 0
    const hrcClient = {
      listSessions: async () => {
        listSessionsCalls += 1
        return [SESSION]
      },
    } as unknown as AcpHrcClient

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/input`,
          body: {
            clientInputId: 'cli-remote-input',
            text: 'must not be delivered',
            sourceKind: 'remote_runtime_projection',
          },
        })
        expect(response.status).toBe(422)
        const body = await json<{ ok: boolean; code: string; clientInputId: string }>(response)
        expect(body).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'remote_control_unavailable',
            clientInputId: 'cli-remote-input',
          })
        )
        expect(listSessionsCalls).toBe(0)
      },
      { hrcClient }
    )
  })

  test('legacy POST /v1/mobile/input route is removed (404)', async () => {
    const hrcClient = makeHrcClient({ sessions: [SESSION], runtimes: [RUNTIME] })
    await withWiredServer(
      async ({ request }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/input',
          body: {
            clientInputId: 'cli-legacy',
            text: 'hi',
            sessionRef: 'agent:cody:project:agent-spaces/lane:main',
          },
        })
        expect(response.status).toBe(404)
      },
      { hrcClient }
    )
  })
})

describe('POST /v1/mobile/sessions/:hostSessionId/interrupt', () => {
  test('resolves hostSessionId to runtime and interrupts it', async () => {
    const interrupted: string[] = []
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      onInterrupt: (runtimeId) => interrupted.push(runtimeId),
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/interrupt`,
          body: { clientInputId: 'cli-i-1' },
        })
        expect(response.status).toBe(200)
        const body = await json<{ ok: boolean; clientInputId: string }>(response)
        expect(body.ok).toBe(true)
        expect(body.clientInputId).toBe('cli-i-1')
        expect(interrupted).toEqual([RUNTIME.runtimeId])
      },
      { hrcClient }
    )
  })

  test('returns 422 with not_interruptible when no runtime is attached', async () => {
    const hrcClient = makeHrcClient({ sessions: [SESSION], runtimes: [] })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/interrupt`,
          body: { clientInputId: 'cli-i-2' },
        })
        expect(response.status).toBe(422)
        const body = await json<{ ok: boolean; code: string }>(response)
        expect(body.ok).toBe(false)
        expect(body.code).toBe('not_interruptible')
      },
      { hrcClient }
    )
  })

  test('refuses remote projection interrupt before invoking local HRC methods', async () => {
    let listSessionsCalls = 0
    const hrcClient = {
      listSessions: async () => {
        listSessionsCalls += 1
        return [SESSION]
      },
    } as unknown as AcpHrcClient

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/interrupt`,
          body: {
            clientInputId: 'cli-remote-interrupt',
            sourceKind: 'remote_runtime_projection',
          },
        })
        expect(response.status).toBe(422)
        const body = await json<{ ok: boolean; code: string; clientInputId: string }>(response)
        expect(body).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'remote_control_unavailable',
            clientInputId: 'cli-remote-interrupt',
          })
        )
        expect(listSessionsCalls).toBe(0)
      },
      { hrcClient }
    )
  })

  test('legacy POST /v1/mobile/interrupt route is removed (404)', async () => {
    const hrcClient = makeHrcClient({ sessions: [SESSION], runtimes: [RUNTIME] })
    await withWiredServer(
      async ({ request }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/interrupt',
          body: {
            clientInputId: 'cli-legacy',
            sessionRef: 'agent:cody:project:agent-spaces/lane:main',
          },
        })
        expect(response.status).toBe(404)
      },
      { hrcClient }
    )
  })
})

describe('GET /v1/mobile/history', () => {
  test('refuses remote projection history before invoking local HRC methods', async () => {
    let watchCalls = 0
    const hrcClient = {
      watch: () => {
        watchCalls += 1
        return (async function* () {})()
      },
    } as unknown as AcpHrcClient

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'GET',
          path: '/v1/mobile/history?sourceKind=remote_runtime_projection',
        })
        expect(response.status).toBe(422)
        const body = await json<{ ok: boolean; code: string }>(response)
        expect(body).toEqual(
          expect.objectContaining({ ok: false, code: 'remote_control_unavailable' })
        )
        expect(watchCalls).toBe(0)
      },
      { hrcClient }
    )
  })
})

describe('removed unscoped mobile session endpoints', () => {
  test('GET /v1/mobile/sessions is removed (404)', async () => {
    await withWiredServer(async ({ request }) => {
      const response = await request({ method: 'GET', path: '/v1/mobile/sessions' })
      expect(response.status).toBe(404)
    })
  })

  test('POST /v1/mobile/sessions/refresh is removed (404)', async () => {
    await withWiredServer(async ({ request }) => {
      const response = await request({
        method: 'POST',
        path: '/v1/mobile/sessions/refresh',
        body: {},
      })
      expect(response.status).toBe(404)
    })
  })
})
