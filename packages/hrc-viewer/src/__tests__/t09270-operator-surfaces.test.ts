import { describe, expect, it } from 'bun:test'

import type { HrcViewerClient, ViewerGhostmux } from '../viewer.js'
import { HrcViewer } from '../viewer.js'

const RUNTIME_ID = 'rt-operator-surface'
const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:T-09270'
const SOCKET = '/tmp/t09270.sock'
const TARGET = 'hrc-t09270:tui'
const MINTED_PANE = 'viewer-pane'

type OperatorSurface = { surfaceId: string; clientTty: string }

type Harness = {
  operations: string[]
  reconcile: () => Promise<void>
  emitLifecycleState: () => Promise<void>
}

function makeHarness(options: {
  operatorSurfaces: readonly OperatorSurface[]
  clients: readonly string[]
  probeFails?: boolean
  viewerRequested?: boolean
  includeMintedPane?: boolean
  latestEventKind?: string
}): Harness {
  const operations: string[] = []
  const row = {
    runtimeId: RUNTIME_ID,
    hostSessionId: 'hsid-operator-surface',
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'ready',
    presentation: { operatorAttachable: true, viewerRequested: options.viewerRequested ?? true },
    tmux: { socketPath: SOCKET, attachTarget: TARGET },
    title: 'Operator paint proof',
    operatorSurfaces: options.operatorSurfaces,
  }
  const latest = {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-09-26T05:00:00.000Z',
    hostSessionId: row.hostSessionId,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    runtimeId: RUNTIME_ID,
    category: 'turn',
    eventKind: options.latestEventKind ?? 'turn.started',
    replayed: false,
    payload: {},
  }
  const client = {
    async health() {
      return { ok: true }
    },
    async tailEvents() {
      return { events: [], ledgerIncarnationId: 'ledger-t09270', headHrcSeq: 1, truncated: false }
    },
    async *watchBoundedEvents() {},
    async listLatestEventBySession() {
      return [latest]
    },
    async listPresentationRuntimes() {
      return { ok: true as const, runtimes: [row] }
    },
  } as unknown as HrcViewerClient
  const ghostmux = {
    async ensureHeadlessViewer() {
      throw new Error('the existing viewer pane must be reused')
    },
    async findHeadlessViewerSurfaceByRuntimeId() {
      return MINTED_PANE
    },
    async listHeadlessViewerPanes() {
      if (options.includeMintedPane === false) return []
      return [
        {
          surfaceId: MINTED_PANE,
          runtimeId: RUNTIME_ID,
          hostSessionId: row.hostSessionId,
          generation: row.generation,
        },
      ]
    },
    async rebindHeadlessViewerPane(surfaceId: string) {
      operations.push(`rebind:${surfaceId}`)
    },
    async setHeadlessViewerTitle(surfaceId: string) {
      operations.push(`pane-title:${surfaceId}`)
    },
    async setTerminalTitle(surfaceId: string) {
      operations.push(`operator-title:${surfaceId}`)
    },
    async setTerminalBackground(surfaceId: string) {
      operations.push(`background:${surfaceId}`)
    },
    async setStatusBar(surfaceId: string) {
      operations.push(`status:${surfaceId}`)
    },
    async setSecondaryStatusBar(surfaceId: string) {
      operations.push(`secondary:${surfaceId}`)
    },
    async hideSecondaryStatusBar(surfaceId: string) {
      operations.push(`hide-secondary:${surfaceId}`)
    },
    async reapHeadlessAgentPane(surfaceId: string) {
      operations.push(`reap:${surfaceId}`)
      return { status: 'reaped' as const, surfaceId, tabCollapsed: true }
    },
  } as unknown as ViewerGhostmux
  const viewer = new HrcViewer({
    client,
    ghostmux,
    async probeTmuxClients() {
      if (options.probeFails === true) throw new Error('tmux client probe unavailable')
      return options.clients
    },
    async readTaskTitles() {
      return new Map([['T-09270', 'Operator surface paint']])
    },
  })
  return {
    operations,
    reconcile: () => viewer.reconcile('start'),
    async emitLifecycleState() {
      await viewer.handleEvent(latest as never)
      await Bun.sleep(175)
    },
  }
}

describe('T-09270 exact-TTY operator presentation', () => {
  it('paints the pane and only the live exact-TTY operator surface', async () => {
    const harness = makeHarness({
      operatorSurfaces: [
        { surfaceId: 'operator-live', clientTty: '/dev/ttys014' },
        { surfaceId: 'operator-live', clientTty: '/dev/ttys014' },
        { surfaceId: 'operator-stale', clientTty: '/dev/ttys070' },
      ],
      clients: ['/dev/ttys014'],
    })

    await harness.reconcile()

    expect(harness.operations).toEqual(
      expect.arrayContaining([
        `pane-title:${MINTED_PANE}`,
        `background:${MINTED_PANE}`,
        `status:${MINTED_PANE}`,
        `secondary:${MINTED_PANE}`,
        'operator-title:operator-live',
        'background:operator-live',
        'status:operator-live',
        'secondary:operator-live',
      ])
    )
    expect(harness.operations).not.toEqual(
      expect.arrayContaining([
        'operator-title:operator-stale',
        'background:operator-stale',
        'status:operator-stale',
        'secondary:operator-stale',
      ])
    )
    expect(harness.operations).not.toEqual(
      expect.arrayContaining(['rebind:operator-live', 'reap:operator-live'])
    )
    expect(harness.operations.filter((operation) => operation === 'status:operator-live')).toHaveLength(1)
  })

  it('withholds a stale cached binding whose TTY is no longer a client', async () => {
    const harness = makeHarness({
      operatorSurfaces: [{ surfaceId: 'operator-stale', clientTty: '/dev/ttys014' }],
      clients: ['/dev/ttys070'],
    })

    await harness.reconcile()

    expect(harness.operations).toContain(`status:${MINTED_PANE}`)
    expect(harness.operations).not.toContain('status:operator-stale')
  })

  it('withholds an observed TTY without an HRC continuity binding for its surface', async () => {
    const harness = makeHarness({ operatorSurfaces: [], clients: ['/dev/ttys014'] })

    await harness.reconcile()

    expect(harness.operations).toContain(`status:${MINTED_PANE}`)
    expect(harness.operations).not.toContain('status:operator-unreported')
  })

  it('withholds operator paint when the tmux client probe is indeterminate', async () => {
    const harness = makeHarness({
      operatorSurfaces: [{ surfaceId: 'operator-unknown', clientTty: '/dev/ttys014' }],
      clients: [],
      probeFails: true,
    })

    await harness.reconcile()

    expect(harness.operations).toContain(`status:${MINTED_PANE}`)
    expect(harness.operations).not.toContain('status:operator-unknown')
  })

  it('rechecks exact TTY membership before a lifecycle status write', async () => {
    const harness = makeHarness({
      operatorSurfaces: [
        { surfaceId: 'operator-live', clientTty: '/dev/ttys014' },
        { surfaceId: 'operator-stale', clientTty: '/dev/ttys070' },
      ],
      clients: ['/dev/ttys014'],
    })

    await harness.emitLifecycleState()

    expect(harness.operations).toEqual(
      expect.arrayContaining([`status:${MINTED_PANE}`, 'status:operator-live'])
    )
    expect(harness.operations).not.toContain('status:operator-stale')
  })

  it('paints a newly bound operator from a ready row when surface.bound is the latest event', async () => {
    const harness = makeHarness({
      operatorSurfaces: [{ surfaceId: 'operator-live', clientTty: '/dev/ttys014' }],
      clients: ['/dev/ttys014'],
      viewerRequested: false,
      includeMintedPane: false,
      latestEventKind: 'surface.bound',
    })

    await harness.reconcile()

    expect(harness.operations).toEqual(
      expect.arrayContaining([
        'operator-title:operator-live',
        'background:operator-live',
        'status:operator-live',
        'secondary:operator-live',
      ])
    )
    expect(harness.operations).not.toEqual(
      expect.arrayContaining(['rebind:operator-live', 'reap:operator-live'])
    )
  })
})
