import { describe, expect, test } from 'bun:test'

import { HrcDomainError, type HrcRuntimeSnapshot, type HrcSessionRecord } from 'hrc-core'

import { parseTmuxAttachArgv } from '../src/handlers/mobile-attach-info.js'
import { isLoopbackPeer } from '../src/routing/peer.js'

import type { AcpHrcClient } from '../src/deps.js'
import { withWiredServer } from './fixtures/wired-server.js'

const NOW = '2026-08-19T14:00:00.000Z'
const HOST_SESSION_ID = 'hsid-attach-info'
const SOCKET_PATH = '/Users/lherron/praesidium/var/run/hrc/btmux/agent control.sock'
const TARGET = 'hrc-clod-acp:tui'
const TMUX_BINARY = '/opt/homebrew/bin/tmux'
const LOOPBACK = { address: '127.0.0.1', family: 'IPv4', port: 51234 }
const TAILSCALE = { address: '100.73.60.81', family: 'IPv4', port: 51235 }

const SESSION: HrcSessionRecord = {
  hostSessionId: HOST_SESSION_ID,
  scopeRef: 'agent:clod:project:agent-control-plane',
  laneRef: 'main',
  generation: 3,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  ancestorScopeRefs: [],
}

const RUNTIME: HrcRuntimeSnapshot = {
  runtimeId: 'rt-attach-info',
  hostSessionId: HOST_SESSION_ID,
  scopeRef: SESSION.scopeRef,
  laneRef: SESSION.laneRef,
  generation: SESSION.generation,
  transport: 'tmux',
  harness: 'claude-code',
  provider: 'anthropic',
  status: 'active',
  tmuxJson: { windowId: '@7', paneId: '%12', windowName: 'tui' },
  supportsInflightInput: true,
  adopted: false,
  createdAt: NOW,
  updatedAt: NOW,
}

const DESCRIPTOR = {
  transport: 'tmux' as const,
  argv: [TMUX_BINARY, '-S', SOCKET_PATH, 'attach-session', '-t', TARGET],
  bindingFence: {
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME.runtimeId,
    generation: SESSION.generation,
    windowId: '@7',
    paneId: '%12',
  },
}

function makeHrcClient(input: {
  sessions?: HrcSessionRecord[]
  runtimes?: HrcRuntimeSnapshot[]
  descriptor?: unknown
  descriptorThrows?: unknown
  onGetAttachDescriptor?: ((runtimeId: string) => void) | undefined
}): AcpHrcClient {
  return {
    listSessions: async () => input.sessions ?? [],
    listRuntimes: async ({ hostSessionId }: { hostSessionId?: string | undefined } = {}) =>
      (input.runtimes ?? []).filter(
        (rt) => hostSessionId === undefined || rt.hostSessionId === hostSessionId
      ),
    getAttachDescriptor: async (runtimeId: string) => {
      input.onGetAttachDescriptor?.(runtimeId)
      if (input.descriptorThrows !== undefined) {
        throw input.descriptorThrows
      }
      return input.descriptor ?? DESCRIPTOR
    },
  } as unknown as AcpHrcClient
}

const PATH = `/v1/mobile/sessions/${HOST_SESSION_ID}/attach-info`

describe('GET /v1/mobile/sessions/:hostSessionId/attach-info', () => {
  test('proxies the hrc attach descriptor for a loopback caller', async () => {
    const seen: string[] = []
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      onGetAttachDescriptor: (runtimeId) => seen.push(runtimeId),
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
        expect(response.status).toBe(200)
        expect(
          await json<{
            local: boolean
            argv: string[]
            socketPath: string
            target: string
            bindingFence: Record<string, unknown>
          }>(response)
        ).toEqual({
          local: true,
          argv: DESCRIPTOR.argv,
          socketPath: SOCKET_PATH,
          target: TARGET,
          bindingFence: DESCRIPTOR.bindingFence,
        })
        expect(seen).toEqual([RUNTIME.runtimeId])
      },
      { hrcClient }
    )
  })

  test('404 not_local for a non-loopback peer, without touching hrc', async () => {
    const seen: string[] = []
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      onGetAttachDescriptor: (runtimeId) => seen.push(runtimeId),
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: TAILSCALE })
        expect(response.status).toBe(404)
        expect((await json<{ reason: string }>(response)).reason).toBe('not_local')
        expect(seen).toEqual([])
      },
      { hrcClient }
    )
  })

  test('404 not_local when the peer is unobservable (gate fails closed)', async () => {
    const hrcClient = makeHrcClient({ sessions: [SESSION], runtimes: [RUNTIME] })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH })
        expect(response.status).toBe(404)
        expect((await json<{ reason: string }>(response)).reason).toBe('not_local')
      },
      { hrcClient }
    )
  })

  test('404 not_local when this hrc node does not own the session', async () => {
    const hrcClient = makeHrcClient({ sessions: [], runtimes: [] })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
        expect(response.status).toBe(404)
        expect((await json<{ reason: string }>(response)).reason).toBe('not_local')
      },
      { hrcClient }
    )
  })

  test('409 not_attachable when the session has no runtime', async () => {
    const hrcClient = makeHrcClient({ sessions: [SESSION], runtimes: [] })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
        expect(response.status).toBe(409)
        expect((await json<{ reason: string }>(response)).reason).toBe('not_attachable')
      },
      { hrcClient }
    )
  })

  test('409 not_attachable when hrc reports the runtime unavailable (no durable lease)', async () => {
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      descriptorThrows: new HrcDomainError(
        'runtime_unavailable',
        'broker runtime "rt-attach-info" is missing tmux socket state'
      ),
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
        expect(response.status).toBe(409)
        const body = await json<{ reason: string; code: string; message: string }>(response)
        expect(body.reason).toBe('not_attachable')
        expect(body.code).toBe('runtime_unavailable')
        expect(body.message).toContain('missing tmux socket state')
      },
      { hrcClient }
    )
  })

  test('409 not_attachable for an attach argv this gateway cannot parse', async () => {
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      descriptor: {
        transport: 'tmux',
        argv: [TMUX_BINARY, '-S', SOCKET_PATH, 'attach-session', '-t', TARGET, '-d'],
        bindingFence: DESCRIPTOR.bindingFence,
      },
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
        expect(response.status).toBe(409)
        expect((await json<{ reason: string }>(response)).reason).toBe('not_attachable')
      },
      { hrcClient }
    )
  })
})

describe('isLoopbackPeer', () => {
  test('accepts loopback v4, the 127/8 block, v6 loopback, and v4-mapped v6', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '[::1]',
    ]) {
      expect(isLoopbackPeer({ address })).toBe(true)
    }
  })

  test('rejects remote addresses, an absent peer, and spoof-shaped values', () => {
    expect(isLoopbackPeer(undefined)).toBe(false)
    for (const address of [
      '100.73.60.81',
      '10.0.0.2',
      '0.0.0.0',
      '',
      '::ffff:10.0.0.2',
      '127.0.0.1.evil.test',
      'fe80::1%en0',
    ]) {
      expect(isLoopbackPeer({ address })).toBe(false)
    }
  })
})

describe('parseTmuxAttachArgv', () => {
  test('reads socket and target back out of the hrc attach argv, spaces included', () => {
    expect(parseTmuxAttachArgv(DESCRIPTOR.argv)).toEqual({
      socketPath: SOCKET_PATH,
      target: TARGET,
    })
  })

  test('refuses any other argv shape rather than guessing', () => {
    expect(parseTmuxAttachArgv([])).toBeUndefined()
    expect(parseTmuxAttachArgv(['tmux', '-S', SOCKET_PATH, 'attach-session', '-t'])).toBeUndefined()
    expect(
      parseTmuxAttachArgv(['tmux', '-S', SOCKET_PATH, 'attach-session', '-t', TARGET, '-d'])
    ).toBeUndefined()
    expect(
      parseTmuxAttachArgv(['tmux', '-S', SOCKET_PATH, 'kill-session', '-t', TARGET])
    ).toBeUndefined()
    expect(
      parseTmuxAttachArgv(['tmux', '-L', 'name', 'attach-session', '-t', TARGET])
    ).toBeUndefined()
    expect(parseTmuxAttachArgv(['tmux', '-S', '', 'attach-session', '-t', TARGET])).toBeUndefined()
    expect(
      parseTmuxAttachArgv([
        '/opt/homebrew/bin/not-tmux',
        '-S',
        SOCKET_PATH,
        'attach-session',
        '-t',
        TARGET,
      ])
    ).toBeUndefined()
  })
})
