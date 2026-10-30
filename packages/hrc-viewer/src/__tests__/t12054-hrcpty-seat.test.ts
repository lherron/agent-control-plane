/**
 * T-12054: an hrcpty seat (T-12046) has no tmux target. rusthrc projects its
 * supervisor socket and shell-quoted attach command as `hrcpty` on both the
 * presentation row and the `runtime.presentation` event; the viewer attaches a
 * pane by running that command, and asks the supervisor's ops socket (not
 * `tmux list-clients`) whether an operator is already attached.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HeadlessViewerPane } from '../ghostmux.js'
import { createHrcptyClientProbe, parseHrcptyClientCount } from '../hrcpty-clients.js'
import { HrcViewer, type HrcViewerClient, type ViewerGhostmux, type ViewerLog } from '../viewer.js'
import { fixtureIdentity } from './session-identity-fixture.js'

const SCOPE = 'agent:clod:project:agent-control-plane:task:T-12054'
const SOCKET = '/tmp/t12054/bipc/de68538e6275/hrcpty.sock'
const ATTACH_COMMAND = `'/Users/lherron/.bun/bin/hrc-pty' attach --socket '${SOCKET}'`

type Event = Parameters<HrcViewer['handleEvent']>[0]
type PresentationRuntimeRow = Awaited<
  ReturnType<HrcViewerClient['listPresentationRuntimes']>
>['runtimes'][number]
/** hrc-sdk does not type the hrcpty presentation yet; rusthrc projects it on the row. */
type HrcptyPresentationRuntimeRow = PresentationRuntimeRow & {
  hrcpty: { socketPath: string; supervisorPid: number; attachCommand: string }
}

function presentationEvent(): Event {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-10-29T17:12:30.000Z',
    hostSessionId: 'hs-1',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    runtimeId: 'rt-hrcpty',
    category: 'runtime',
    eventKind: 'runtime.presentation',
    replayed: false,
    identity: fixtureIdentity(SCOPE),
    // The birth event rusthrc appends for an hrcpty seat (hrc-store broker.rs).
    payload: {
      invocation: { operatorAttachPending: false },
      presentation: { operatorAttachable: true, viewerRequested: true },
      hrcpty: { socketPath: SOCKET, attachCommand: ATTACH_COMMAND },
    },
  }
}

function makeHarness(attachedClients: number) {
  const rows: HrcptyPresentationRuntimeRow[] = [
    {
      runtimeId: 'rt-hrcpty',
      hostSessionId: 'hs-1',
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      identity: fixtureIdentity(SCOPE),
      status: 'idle',
      presentation: { operatorAttachable: true, viewerRequested: true },
      hrcpty: { socketPath: SOCKET, supervisorPid: 59921, attachCommand: ATTACH_COMMAND },
      operatorSurfaces: [],
    },
  ]
  const createdCalls: Array<Parameters<ViewerGhostmux['ensureHeadlessViewer']>[0]> = []
  const hrcptyProbeCalls: string[] = []
  const tmuxProbeCalls: unknown[] = []
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const panes: HeadlessViewerPane[] = []
  const client: HrcViewerClient = {
    async health() {
      return { ok: true }
    },
    async tailEvents() {
      return { events: [], ledgerIncarnationId: 'ledger-1', headHrcSeq: 1, truncated: false }
    },
    async *watchBoundedEvents() {},
    async listLatestEventBySession() {
      return []
    },
    async listPresentationRuntimes() {
      return { ok: true, runtimes: rows }
    },
  }
  const ghostmux: ViewerGhostmux = {
    async ensureHeadlessViewer(options) {
      if (options.skipCreateWhen !== undefined && (await options.skipCreateWhen())) {
        return { status: 'skipped', reason: 'create_vetoed' }
      }
      createdCalls.push(options)
      return { status: 'created', surfaceId: `surface-${createdCalls.length}`, tabKey: 'tab' }
    },
    async findHeadlessViewerSurfaceByRuntimeId() {
      return null
    },
    async listHeadlessViewerPanes() {
      return panes
    },
    async rebindHeadlessViewerPane() {},
    async setHeadlessViewerTitle() {},
    async setStatusBar() {},
    async setSecondaryStatusBar() {},
    async hideSecondaryStatusBar() {},
    async reapHeadlessAgentPane(surfaceId) {
      return { status: 'reaped', surfaceId, tabCollapsed: true }
    },
  }
  const log: ViewerLog = (_level, name, fields = {}) => logs.push({ event: name, fields })
  const viewer = new HrcViewer({
    client,
    ghostmux,
    log,
    lingerSeconds: 300,
    now: () => Date.parse('2026-10-29T17:12:30.000Z'),
    schedule() {
      return {} as ReturnType<typeof setTimeout>
    },
    clearScheduled() {},
    async probeTmuxClients(...args) {
      tmuxProbeCalls.push(args)
      return []
    },
    async probeHrcptyClients(socketPath) {
      hrcptyProbeCalls.push(socketPath)
      return attachedClients
    },
    async readTaskTitles() {
      return new Map<string, string>()
    },
  })
  return { viewer, createdCalls, hrcptyProbeCalls, tmuxProbeCalls, logs }
}

describe('T-12054 viewer placement of an hrcpty seat', () => {
  it('the birth presentation event mints a pane that runs the hrc-pty attach command', async () => {
    const harness = makeHarness(0)

    await harness.viewer.handleEvent(presentationEvent())

    expect(harness.createdCalls).toHaveLength(1)
    const created = harness.createdCalls[0]
    expect(
      created?.attachCommand.startsWith(`${ATTACH_COMMAND}; hrc monitor session-report `)
    ).toBe(true)
    expect(created?.attachCommand.endsWith('; exit')).toBe(true)
    expect(created?.attachTarget).toEqual({ socketPath: SOCKET })
    expect(harness.hrcptyProbeCalls).toEqual([SOCKET])
    expect(harness.tmuxProbeCalls).toEqual([])
  })

  it('an operator already attached to the supervisor vetoes the create', async () => {
    const harness = makeHarness(1)

    await harness.viewer.handleEvent(presentationEvent())

    expect(harness.createdCalls).toHaveLength(0)
    const skipped = harness.logs.find(
      (entry) => entry.event === 'broker_headless_viewer.skipped_operator_attached'
    )
    expect(skipped?.fields).toMatchObject({
      runtimeId: 'rt-hrcpty',
      transport: 'hrcpty',
      socketPath: SOCKET,
      clients: 1,
    })
  })

  it('reconcile mints a pane from the hrcpty presentation row', async () => {
    const harness = makeHarness(0)

    await harness.viewer.reconcile('timer')

    expect(harness.createdCalls).toHaveLength(1)
    expect(harness.createdCalls[0]?.attachTarget).toEqual({ socketPath: SOCKET })
  })
})

describe('T-12054 hrc-pty client probe', () => {
  const dirs: string[] = []
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** An ops socket that speaks the hrc-pty framing: hello with the token, then status. */
  async function fakeSupervisor(input: {
    token?: string | undefined
    status?: unknown
    silent?: boolean | undefined
  }): Promise<{ socketPath: string; methods: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 't12054-'))
    dirs.push(dir)
    const socketPath = join(dir, 'hrcpty.sock')
    if (input.token !== undefined) writeFileSync(join(dir, 'attach.token'), `${input.token}\n`)
    const methods: string[] = []
    const server = createServer((connection) => {
      let buffered = ''
      let authed = false
      connection.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
        for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
          const frame = JSON.parse(buffered.slice(0, i)) as {
            id: number
            method: string
            params: Record<string, unknown>
          }
          buffered = buffered.slice(i + 1)
          methods.push(frame.method)
          if (input.silent === true) continue
          if (frame.method === 'hello' && frame.params['token'] === 'tok-1') authed = true
          const reply =
            frame.method === 'hello'
              ? authed
                ? { result: { protocol: 'hrc-pty/1', pid: 1 } }
                : { error: { code: -32000, message: 'unauthorized: token mismatch' } }
              : authed && frame.method === 'status'
                ? { result: input.status }
                : { error: { code: -32000, message: 'unauthorized: hello first' } }
          connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...reply })}\n`)
        }
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return { socketPath, methods }
  }

  it('reads clients.total after a hello carrying the token beside the socket', async () => {
    const supervisor = await fakeSupervisor({
      token: 'tok-1',
      status: { clients: { total: 2, readWrite: 1, readOnly: 1 } },
    })
    expect(await createHrcptyClientProbe()(supervisor.socketPath)).toBe(2)
    expect(supervisor.methods).toEqual(['hello', 'status'])
  })

  it('answers 0 when nobody is attached', async () => {
    const supervisor = await fakeSupervisor({
      token: 'tok-1',
      status: { clients: { total: 0, readWrite: 0, readOnly: 0 } },
    })
    expect(await createHrcptyClientProbe()(supervisor.socketPath)).toBe(0)
  })

  it('fails open to 0 on a refused hello, a missing token, a missing socket and a timeout', async () => {
    const refused = await fakeSupervisor({ token: 'wrong', status: { clients: { total: 3 } } })
    expect(await createHrcptyClientProbe()(refused.socketPath)).toBe(0)
    expect(refused.methods).toEqual(['hello'])

    const tokenless = await fakeSupervisor({ status: { clients: { total: 3 } } })
    expect(await createHrcptyClientProbe()(tokenless.socketPath)).toBe(0)
    expect(tokenless.methods).toEqual([])

    expect(await createHrcptyClientProbe()('/nonexistent/t12054/hrcpty.sock')).toBe(0)

    const silent = await fakeSupervisor({ token: 'tok-1', silent: true })
    expect(await createHrcptyClientProbe({ timeoutMs: 50 })(silent.socketPath)).toBe(0)
  })

  it('counts only an integer clients.total', () => {
    expect(parseHrcptyClientCount({ clients: { total: 1 } })).toBe(1)
    expect(parseHrcptyClientCount({ clients: { total: '1' } })).toBe(0)
    expect(parseHrcptyClientCount({ clients: 1 })).toBe(0)
    expect(parseHrcptyClientCount(null)).toBe(0)
  })
})
