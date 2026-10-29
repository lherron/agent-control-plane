import { describe, expect, test } from 'bun:test'

import { HrcDomainError, type HrcRuntimeSnapshot, type HrcSessionRecord } from 'hrc-core'

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
      return 'descriptor' in input ? input.descriptor : DESCRIPTOR
    },
  } as unknown as AcpHrcClient
}

const PATH = `/v1/mobile/sessions/${HOST_SESSION_ID}/attach-info`

describe('GET /v1/mobile/sessions/:hostSessionId/attach-info', () => {
  test('proxies the hrc attach descriptor, socket and target parsed out, for any loopback peer form', async () => {
    const seen: string[] = []
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      onGetAttachDescriptor: (runtimeId) => seen.push(runtimeId),
    })
    // Loopback v4, the 127/8 block, v6 loopback (both spellings, bracketed) and v4-mapped v6.
    const addresses = [
      LOOPBACK.address,
      '127.1.2.3',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '[::1]',
    ]

    await withWiredServer(
      async ({ request, json }) => {
        for (const address of addresses) {
          const response = await request({ method: 'GET', path: PATH, peer: { address } })
          expect({ address, status: response.status }).toEqual({ address, status: 200 })
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
        }
        expect(seen).toEqual(addresses.map(() => RUNTIME.runtimeId))
      },
      { hrcClient }
    )
  })

  test('404 not_local for a remote or spoof-shaped peer, without touching hrc', async () => {
    const seen: string[] = []
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      onGetAttachDescriptor: (runtimeId) => seen.push(runtimeId),
    })

    await withWiredServer(
      async ({ request, json }) => {
        for (const address of [
          TAILSCALE.address,
          '10.0.0.2',
          '0.0.0.0',
          '',
          '::ffff:10.0.0.2',
          '127.0.0.1.evil.test',
          'fe80::1%en0',
        ]) {
          const response = await request({ method: 'GET', path: PATH, peer: { address } })
          expect({ address, status: response.status }).toEqual({ address, status: 404 })
          expect((await json<{ reason: string }>(response)).reason).toBe('not_local')
        }
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

  test('409 not_attachable, never 500, when hrc resolves a null descriptor', async () => {
    // hrc-server served an empty 200 to coalesced attach callers, which the SDK
    // read as `null`; the handler then threw on `descriptor.argv` (T-10760).
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [RUNTIME],
      descriptor: null,
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
        expect(response.status).toBe(409)
        const body = await json<{ reason: string; runtimeId: string; message: string }>(response)
        expect(body.reason).toBe('not_attachable')
        expect(body.runtimeId).toBe(RUNTIME.runtimeId)
        expect(body.message).toContain(RUNTIME.runtimeId)
      },
      { hrcClient }
    )
  })

  test('409 not_attachable for any attach argv shape this gateway cannot parse', async () => {
    const refusedShapes: string[][] = [
      [],
      ['tmux', '-S', SOCKET_PATH, 'attach-session', '-t'],
      [TMUX_BINARY, '-S', SOCKET_PATH, 'attach-session', '-t', TARGET, '-d'],
      ['tmux', '-S', SOCKET_PATH, 'kill-session', '-t', TARGET],
      ['tmux', '-L', 'name', 'attach-session', '-t', TARGET],
      ['tmux', '-S', '', 'attach-session', '-t', TARGET],
      ['/opt/homebrew/bin/not-tmux', '-S', SOCKET_PATH, 'attach-session', '-t', TARGET],
    ]
    for (const argv of refusedShapes) {
      const hrcClient = makeHrcClient({
        sessions: [SESSION],
        runtimes: [RUNTIME],
        descriptor: { transport: 'tmux', argv, bindingFence: DESCRIPTOR.bindingFence },
      })

      await withWiredServer(
        async ({ request, json }) => {
          const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
          expect({ argv, status: response.status }).toEqual({ argv, status: 409 })
          expect((await json<{ reason: string }>(response)).reason).toBe('not_attachable')
        },
        { hrcClient }
      )
    }
  })

  test('proxies an hrcpty seat descriptor with its socket read back out of the argv (T-12046)', async () => {
    const hrcptySocket = '/Users/lherron/praesidium/var/run/hrc/bipc/de68538e6275/hrcpty.sock'
    const argv = ['/Users/lherron/.bun/bin/hrc-pty', 'attach', '--socket', hrcptySocket]
    const bindingFence = {
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME.runtimeId,
      generation: SESSION.generation,
      supervisorPid: 59921,
    }
    const hrcClient = makeHrcClient({
      sessions: [SESSION],
      runtimes: [{ ...RUNTIME, transport: 'hrcpty', tmuxJson: undefined }],
      descriptor: { transport: 'hrcpty', argv, bindingFence },
    })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
        expect(response.status).toBe(200)
        expect(await json(response)).toEqual({
          local: true,
          transport: 'hrcpty',
          argv,
          socketPath: hrcptySocket,
          bindingFence,
        })
      },
      { hrcClient }
    )
  })

  test('409 not_attachable for an hrcpty argv shape this gateway cannot parse', async () => {
    const socket = '/tmp/bipc/x/hrcpty.sock'
    const refusedShapes: string[][] = [
      [],
      ['hrc-pty', 'attach', '--socket'],
      ['hrc-pty', 'attach', socket],
      ['hrc-pty', 'attach', '--socket', ''],
      ['hrc-pty', 'attach', '--socket', socket, '--read-only'],
      ['hrc-pty', 'serve', '--socket', socket],
      ['/usr/local/bin/not-hrc-pty', 'attach', '--socket', socket],
      // A tmux argv under the hrcpty transport is a mismatch, never a tmux attach.
      DESCRIPTOR.argv,
    ]
    for (const argv of refusedShapes) {
      const hrcClient = makeHrcClient({
        sessions: [SESSION],
        runtimes: [RUNTIME],
        descriptor: { transport: 'hrcpty', argv, bindingFence: DESCRIPTOR.bindingFence },
      })

      await withWiredServer(
        async ({ request, json }) => {
          const response = await request({ method: 'GET', path: PATH, peer: LOOPBACK })
          expect({ argv, status: response.status }).toEqual({ argv, status: 409 })
          expect((await json<{ reason: string }>(response)).reason).toBe('not_attachable')
        },
        { hrcClient }
      )
    }
  })
})
