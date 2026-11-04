import { describe, expect, test } from 'bun:test'
import { fixtureIdentity } from './session-identity-fixture.js'

import type { HeadlessViewerPane } from '../ghostmux.js'
import { HrcViewer, type HrcViewerClient, type ViewerGhostmux, type ViewerLog } from '../viewer.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:primary'
type Event = Parameters<HrcViewer['handleEvent']>[0]

function event(eventKind: string, overrides: Partial<Event> = {}): Event {
  return {
    hrcSeq: 1,
    eventId: 'evt-1',
    ts: '2026-08-26T12:00:00.000Z',
    hostSessionId: 'hs-1',
    scopeRef: SCOPE,
    identity: fixtureIdentity(
      typeof overrides['scopeRef'] === 'string' ? overrides['scopeRef'] : SCOPE
    ),
    laneRef: 'main',
    generation: 1,
    runtimeId: 'rt-1',
    category: 'runtime',
    eventKind,
    replayed: false,
    payload: {},
    ...overrides,
  } as Event
}

function presentationRow(overrides: Record<string, unknown> = {}) {
  return {
    identity: fixtureIdentity(
      typeof overrides['scopeRef'] === 'string' ? overrides['scopeRef'] : SCOPE
    ),
    runtimeId: 'rt-1',
    hostSessionId: 'hs-1',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'idle',
    presentation: { operatorAttachable: true, viewerRequested: true },
    tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
    ...overrides,
  }
}

function makeHarness(input?: {
  rows?: ReturnType<typeof presentationRow>[]
  panes?: HeadlessViewerPane[]
  latest?: Event[]
  lingerSeconds?: number
  /** Task id -> wrkq title. Omit to answer every batch with an empty map. */
  taskTitles?: Record<string, string>
  /** Force the batched title read to fail, as a deleted id or a missing wrkq does. */
  titleReadFails?: boolean
  clients?: readonly string[]
}) {
  const rows = input?.rows ?? []
  const panes = input?.panes ?? []
  const latest = input?.latest ?? []
  const ensureCalls: Array<Record<string, unknown>> = []
  const rebindCalls: Array<Record<string, unknown>> = []
  const titleCalls: Array<{ surfaceId: string; title: string }> = []
  const terminalTitleCalls: Array<{ surfaceId: string; title: string }> = []
  const backgroundCalls: Array<{ surfaceId: string; hex: string }> = []
  const statusCalls: Array<{ surfaceId: string; right: string }> = []
  const secondaryCalls: Array<{ surfaceId: string; left: string; center: string; right: string }> =
    []
  const secondaryHides: string[] = []
  const titleReads: string[][] = []
  const reapCalls: Array<{ surfaceId: string; runtimeId: string }> = []
  const scheduled: Array<() => void> = []
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const reads = { presentation: 0, latest: 0 }
  const client = {
    async health() {
      return { ok: true }
    },
    async tailEvents() {
      return { events: [], ledgerIncarnationId: 'ledger-1', headHrcSeq: 1, truncated: false }
    },
    async *watchBoundedEvents() {},
    async listLatestEventBySession() {
      reads.latest += 1
      return latest
    },
    async listPresentationRuntimes() {
      reads.presentation += 1
      return { ok: true as const, runtimes: rows }
    },
  } as unknown as HrcViewerClient
  const ghostmux: ViewerGhostmux = {
    async ensureHeadlessViewer(options) {
      ensureCalls.push(options)
      return { status: 'created', surfaceId: `surface-${ensureCalls.length}`, tabKey: 'tab' }
    },
    async findHeadlessViewerSurfaceByRuntimeId(runtimeId) {
      return panes.find((pane) => pane.runtimeId === runtimeId)?.surfaceId ?? null
    },
    async listHeadlessViewerPanes() {
      return panes
    },
    async rebindHeadlessViewerPane(surfaceId, options) {
      rebindCalls.push({ surfaceId, ...options })
    },
    async setHeadlessViewerTitle(surfaceId, title) {
      titleCalls.push({ surfaceId, title })
    },
    async setTerminalTitle(surfaceId, title) {
      terminalTitleCalls.push({ surfaceId, title })
    },
    async setTerminalBackground(surfaceId, hex) {
      backgroundCalls.push({ surfaceId, hex })
    },
    async setStatusBar(surfaceId, spec) {
      statusCalls.push({ surfaceId, right: spec.right })
    },
    async setSecondaryStatusBar(surfaceId, spec) {
      secondaryCalls.push({ surfaceId, ...spec })
    },
    async hideSecondaryStatusBar(surfaceId) {
      secondaryHides.push(surfaceId)
    },
    async reapHeadlessAgentPane(surfaceId, runtimeId) {
      reapCalls.push({ surfaceId, runtimeId })
      return { status: 'reaped', surfaceId, tabCollapsed: true }
    },
  }
  const log: ViewerLog = (_level, name, fields = {}) => logs.push({ event: name, fields })
  const viewer = new HrcViewer({
    client,
    ghostmux,
    log,
    lingerSeconds: input?.lingerSeconds ?? 300,
    now: () => Date.parse('2026-08-26T12:00:00.000Z'),
    schedule(fn) {
      scheduled.push(fn)
      return {} as ReturnType<typeof setTimeout>
    },
    clearScheduled() {},
    probeTmuxClients: async () => input?.clients ?? [],
    async readTaskTitles(taskIds) {
      titleReads.push([...taskIds])
      if (input?.titleReadFails === true) return new Map()
      const titles = new Map<string, string>()
      for (const taskId of taskIds) {
        const title = input?.taskTitles?.[taskId]
        if (title !== undefined) titles.set(taskId, title)
      }
      return titles
    },
  })
  return {
    viewer,
    reads,
    ensureCalls,
    rebindCalls,
    titleCalls,
    terminalTitleCalls,
    backgroundCalls,
    statusCalls,
    secondaryCalls,
    secondaryHides,
    titleReads,
    reapCalls,
    scheduled,
    logs,
  }
}

describe('HrcViewer event reactions (§4.3)', () => {
  test('operator-attach pending skips only that invocation; a later detached invocation mints', async () => {
    const harness = makeHarness()
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: true },
          presentation: { operatorAttachable: true, viewerRequested: false },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    expect(harness.ensureCalls).toHaveLength(0)
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: true },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.ensureCalls[0]?.['attachCommand']).toContain("attach-session -t 'viewer:tui'")
  })

  test('T-08115: the pane outlives the reaper deadline so the reaper decides the race', async () => {
    // The pane's own `session-report --wait-timeout N; exit` and scheduleReap's
    // timer both count from the same terminal event. Given the same N they are
    // one deadline separated by startup jitter, and whichever won decided
    // whether the log said `reaped` or reported a gone pane as a skip. The
    // pane's timeout must therefore be STRICTLY GREATER than the linger.
    const harness = makeHarness({ lingerSeconds: 300 })
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: true },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    const attachCommand = String(harness.ensureCalls[0]?.['attachCommand'] ?? '')
    const waitTimeout = Number(/--wait-timeout (\d+)/.exec(attachCommand)?.[1])
    expect(Number.isFinite(waitTimeout)).toBe(true)
    expect(waitTimeout).toBeGreaterThan(300)
  })

  test('viewerRequested=false suppresses the live event path for a detached attachable runtime', async () => {
    const harness = makeHarness()
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: false },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    expect(harness.ensureCalls).toHaveLength(0)
  })

  test('terminal event schedules a runtime-fenced reap', async () => {
    const harness = makeHarness({
      panes: [{ surfaceId: 'surface-1', windowKey: 'default', runtimeId: 'rt-1' }],
      lingerSeconds: 0,
    })
    await harness.viewer.handleEvent(event('runtime.crashed'))
    expect(harness.scheduled).toHaveLength(1)
    harness.scheduled[0]?.()
    await Bun.sleep(0)
    expect(harness.reapCalls).toEqual([{ surfaceId: 'surface-1', runtimeId: 'rt-1' }])
  })
})

describe('HrcViewer reconcile (§4.5 / §5.5)', () => {
  test('record-less and viewerRequested=false rows never mint panes', async () => {
    const harness = makeHarness({
      rows: [
        presentationRow({ runtimeId: 'rt-recordless', presentation: undefined }),
        presentationRow({
          runtimeId: 'rt-suppressed',
          presentation: { operatorAttachable: true, viewerRequested: false },
        }),
      ],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(0)
  })

  test('adopts a record-less pane, rebinds generation metadata, and status-paints it', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ presentation: undefined, title: 'Adopted' })],
      panes: [
        {
          surfaceId: 'surface-old',
          windowKey: 'default',
          paneKey: 'agent:cody:project:hrc-runtime:task:primary#main',
          runtimeId: 'rt-old',
        },
      ],
      latest: [event('turn.awaiting_input')],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.rebindCalls).toHaveLength(0)
    expect(harness.ensureCalls[0]).toMatchObject({
      runtimeId: 'rt-1',
      hostSessionId: 'hs-1',
      generation: 1,
    })
    expect(harness.titleCalls).toContainEqual({ surfaceId: 'surface-old', title: 'Adopted' })
    expect(harness.statusCalls).toContainEqual({
      surfaceId: 'surface-old',
      right: '⏸ awaiting input',
    })
  })

  test('viewerRequested=true with attachability and tmux mints the missing pane', async () => {
    const harness = makeHarness({ rows: [presentationRow()] })
    await harness.viewer.reconcile('timer')
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.ensureCalls[0]).toMatchObject({
      runtimeId: 'rt-1',
      hostSessionId: 'hs-1',
      generation: 1,
    })
  })

  test('uses the canonical lane carried by HRC', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ laneRef: 'lane:viewer-smoke' })],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.ensureCalls[0]).toMatchObject({
      laneRef: 'lane:viewer-smoke',
    })
    expect(
      harness.logs.some((entry) => entry.event === 'broker_headless_viewer.reconcile_failed')
    ).toBe(false)
  })
})

/**
 * A seat idle for more than 12 hours is not re-attached: reconcile (start,
 * reconnect, timer, stream reset) mints no pane for it. "Idle since" is the
 * runtime's latest lifecycle event; a busy/starting row is active whatever its
 * last event says, and a row with no known event keeps the old mint behavior.
 * The seat's next turn brings the pane back without waiting for the timer.
 */
describe('HrcViewer dormant seats (idle > 12h)', () => {
  // Harness clock is 2026-08-26T12:00:00Z.
  const OVER_12H = '2026-08-25T23:59:00.000Z'
  const UNDER_12H = '2026-08-26T00:01:00.000Z'

  test('does not mint a pane for a ready seat whose last event is over 12h old', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ status: 'ready' })],
      latest: [event('turn.completed', { ts: OVER_12H })],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(0)
    expect(harness.logs).toContainEqual({
      event: 'broker_headless_viewer.skipped_dormant',
      fields: { runtimeId: 'rt-1', scopeRef: SCOPE, lastEventAt: OVER_12H },
    })
  })

  test('mints a pane for a ready seat idle for less than 12h', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ status: 'ready' })],
      latest: [event('turn.completed', { ts: UNDER_12H })],
    })
    await harness.viewer.reconcile('timer')
    expect(harness.ensureCalls).toHaveLength(1)
  })

  test('a busy seat is active regardless of its last event age', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ status: 'busy' })],
      latest: [event('turn.completed', { ts: OVER_12H })],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(1)
  })

  test("the dormant seat's next turn re-attaches it immediately", async () => {
    const rows = [presentationRow({ status: 'ready' })]
    const latest = [event('turn.completed', { ts: OVER_12H })]
    const harness = makeHarness({ rows, latest })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(0)

    // Unrelated non-turn activity does not wake it.
    await harness.viewer.handleEvent(event('broker.seat.transition'))
    expect(harness.ensureCalls).toHaveLength(0)

    rows[0] = presentationRow({ status: 'busy' })
    latest[0] = event('turn.started')
    await harness.viewer.handleEvent(event('turn.started'))
    expect(harness.ensureCalls).toHaveLength(1)
    expect(harness.ensureCalls[0]).toMatchObject({ runtimeId: 'rt-1' })
  })

  test('an existing pane for a dormant seat is still adopted, not reaped', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ status: 'ready' })],
      panes: [
        {
          surfaceId: 'surface-1',
          windowKey: 'default',
          runtimeId: 'rt-1',
          hostSessionId: 'hs-1',
          generation: 1,
        },
      ],
      latest: [event('turn.completed', { ts: OVER_12H })],
    })
    await harness.viewer.reconcile('start')
    expect(harness.ensureCalls).toHaveLength(0)
    expect(harness.scheduled).toHaveLength(0)
    expect(harness.statusCalls).toContainEqual({ surfaceId: 'surface-1', right: '✓ idle' })
  })
})

/**
 * T-08331: the secondary status bar is a TITLE bar. It answers "what task is
 * this pane?" — a fact — so it is stamped on every reconcile pass regardless of
 * what the runtime's latest event was, and it must render byte-identically to
 * what hcs writes on its own context panes until T-08332 removes that writer.
 */
describe('HrcViewer secondary status bar (T-08331)', () => {
  const TASK_SCOPE = 'agent:cody:project:wrkq:task:T-08259'
  const TASK_PANE_KEY = 'agent:cody:project:wrkq:task:T-08259#main'

  function taskHarness(input?: Parameters<typeof makeHarness>[0]) {
    return makeHarness({
      rows: [presentationRow({ scopeRef: TASK_SCOPE })],
      panes: [
        {
          surfaceId: 'surface-task',
          windowKey: 'default',
          paneKey: TASK_PANE_KEY,
          runtimeId: 'rt-1',
          scopeRef: TASK_SCOPE,
        },
      ],
      taskTitles: { 'T-08259': 'wrkq: teach cat to take many ids' },
      ...input,
    })
  }

  test('stamps `▸ <title>` in left with center and right empty, matching hcs byte for byte', async () => {
    const harness = taskHarness()
    await harness.viewer.reconcile('start')
    expect(harness.secondaryCalls).toContainEqual({
      surfaceId: 'surface-task',
      left: '▸ wrkq: teach cat to take many ids',
      center: '',
      right: '',
    })
  })

  test('stamps a pane whose latest event has no viewer state — the state gate must not cover it', async () => {
    // `session.created` is not one of the eight kinds viewerStateForEventKind
    // maps, so paintFromLatest returns early and writes no primary bar. A title
    // bar behind that gate would hold a stale title until the next turn boundary.
    const harness = taskHarness({
      latest: [event('session.created', { scopeRef: TASK_SCOPE })],
    })
    await harness.viewer.reconcile('timer')
    expect(harness.statusCalls).toHaveLength(0)
    expect(harness.secondaryCalls).toHaveLength(1)
    expect(harness.secondaryCalls[0]?.left).toBe('▸ wrkq: teach cat to take many ids')
  })

  test('one batched read covers every task-scoped pane in the pass', async () => {
    const harness = makeHarness({
      rows: [
        presentationRow({ scopeRef: TASK_SCOPE }),
        presentationRow({ runtimeId: 'rt-2', hostSessionId: 'hs-2', scopeRef: SCOPE }),
        presentationRow({
          runtimeId: 'rt-3',
          hostSessionId: 'hs-3',
          scopeRef: 'agent:clod:project:hrc-runtime:task:T-08296',
        }),
      ],
      taskTitles: { 'T-08259': 'first', 'T-08296': 'second' },
    })
    await harness.viewer.reconcile('start')
    // Exactly one read, carrying both task ids; the `:primary` scope contributes none.
    expect(harness.titleReads).toHaveLength(1)
    expect(harness.titleReads[0]?.sort()).toEqual(['T-08259', 'T-08296'])
  })

  test('a `:primary` seat is HIDDEN, not skipped, so a recycled pane drops the old title', async () => {
    const harness = makeHarness({
      rows: [presentationRow()],
      panes: [
        {
          surfaceId: 'surface-primary',
          windowKey: 'default',
          paneKey: 'agent:cody:project:hrc-runtime:task:primary#main',
          runtimeId: 'rt-1',
          scopeRef: SCOPE,
        },
      ],
    })
    await harness.viewer.reconcile('start')
    expect(harness.secondaryHides).toContain('surface-primary')
    expect(harness.secondaryCalls).toHaveLength(0)
  })

  test('a failed title read degrades to the last-known title and never blanks the bar', async () => {
    const harness = taskHarness()
    await harness.viewer.reconcile('start')
    expect(harness.secondaryCalls).toHaveLength(1)

    // Same viewer, now with wrkq answering nothing — a deleted id failing the
    // whole batch, or wrkq gone from PATH.
    const failing = taskHarness({ titleReadFails: true })
    await failing.viewer.reconcile('start')
    expect(failing.secondaryHides).toHaveLength(0)
    // Never seen: no title to hold, so the bar is left exactly as it was.
    expect(failing.secondaryCalls).toHaveLength(0)
  })

  test('a retitled task is restamped on the next reconcile with no lifecycle event', async () => {
    const titles: Record<string, string> = { 'T-08259': 'before' }
    const harness = makeHarness({
      rows: [presentationRow({ scopeRef: TASK_SCOPE })],
      panes: [
        {
          surfaceId: 'surface-task',
          windowKey: 'default',
          paneKey: TASK_PANE_KEY,
          runtimeId: 'rt-1',
          scopeRef: TASK_SCOPE,
        },
      ],
      taskTitles: titles,
    })
    await harness.viewer.reconcile('start')
    titles['T-08259'] = 'after'
    await harness.viewer.reconcile('timer')
    expect(harness.secondaryCalls.map((call) => call.left)).toEqual(['▸ before', '▸ after'])
  })

  test('a terminal runtime hides the bar so a lingering pane sheds its title', async () => {
    const harness = taskHarness()
    await harness.viewer.handleEvent(
      event('runtime.terminated', { scopeRef: TASK_SCOPE, runtimeId: 'rt-1' })
    )
    expect(harness.secondaryHides).toContain('surface-task')
  })

  test('a pane with no presentation row hides the bar on its way to the reaper', async () => {
    const harness = makeHarness({
      panes: [
        {
          surfaceId: 'surface-orphan',
          windowKey: 'default',
          paneKey: TASK_PANE_KEY,
          runtimeId: 'rt-gone',
          scopeRef: TASK_SCOPE,
        },
      ],
    })
    await harness.viewer.reconcile('start')
    expect(harness.secondaryHides).toContain('surface-orphan')
  })
})

describe('T-12511 retained presentation', () => {
  test('bootstrap reads once and lifecycle flushes reuse the retained row', async () => {
    const harness = makeHarness({ rows: [presentationRow()] })
    await harness.viewer.reconcile('start')
    expect(harness.reads).toEqual({ presentation: 1, latest: 1 })
    await harness.viewer.handleEvent(event('turn.started'))
    await Bun.sleep(175)
    expect(harness.reads).toEqual({ presentation: 1, latest: 1 })
  })

  test('a presentation event updates only its runtime without a fleet read', async () => {
    const harness = makeHarness({
      rows: [presentationRow(), presentationRow({ runtimeId: 'rt-2' })],
    })
    await harness.viewer.reconcile('start')
    const before = harness.ensureCalls.length
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: true },
          tmux: { socketPath: '/tmp/new.sock', attachTarget: 'new:tui' },
          title: 'Updated title',
        },
      })
    )
    expect(harness.ensureCalls.slice(before)).toHaveLength(1)
    expect(harness.ensureCalls.at(-1)).toMatchObject({
      runtimeId: 'rt-1',
      attachTarget: { socketPath: '/tmp/new.sock' },
    })
    expect(harness.titleCalls.at(-1)?.title).toBe('Updated title')
    expect(harness.reads).toEqual({ presentation: 1, latest: 1 })
  })

  test('metadata applies and clears resolved values without rereading the fleet', async () => {
    const harness = makeHarness({
      rows: [presentationRow()],
      panes: [{ surfaceId: 'pane', runtimeId: 'rt-1', hostSessionId: 'hs-1', generation: 1 }],
    })
    await harness.viewer.reconcile('start')
    const originalTitle = harness.titleCalls.at(-1)?.title
    for (const resolved of [{ value: 'Live title', source: 'api' }, null]) {
      await harness.viewer.handleEvent(
        event('session.metadata.changed', { payload: { key: 'title', resolved } })
      )
    }
    expect(harness.reads).toEqual({ presentation: 1, latest: 1 })
    expect(harness.titleCalls.map((call) => call.title)).toEqual([
      originalTitle,
      'Live title',
      originalTitle,
    ])
  })

  test('surface changes and terminal reaping reuse retained state without recreating panes', async () => {
    const harness = makeHarness({
      rows: [presentationRow()],
      panes: [{ surfaceId: 'pane', runtimeId: 'rt-1', hostSessionId: 'hs-1', generation: 1 }],
    })
    await harness.viewer.reconcile('start')
    for (const eventKind of [
      'surface.bound',
      'surface.rebound',
      'surface.unbound',
      'runtime.terminated',
      'surface.bound',
    ]) {
      await harness.viewer.handleEvent(
        event(eventKind, {
          payload: { surfaceKind: 'ghostty', surfaceId: 'operator', clientTty: '/dev/test' },
        })
      )
    }
    expect(harness.ensureCalls).toHaveLength(0)
    expect(harness.scheduled).toHaveLength(1)
    expect(harness.reads).toEqual({ presentation: 1, latest: 1 })
  })

  test('a missing referenced runtime still triggers full recovery', async () => {
    const rows = [presentationRow()]
    const harness = makeHarness({ rows })
    await harness.viewer.reconcile('start')
    rows.push(presentationRow({ runtimeId: 'rt-new' }))
    await harness.viewer.handleEvent(event('turn.started', { runtimeId: 'rt-new' }))
    await Bun.sleep(175)
    expect(harness.reads).toEqual({ presentation: 2, latest: 2 })
  })
})

describe('T-12511 retained action fences', () => {
  test('a dormant wake respects a later presentation veto', async () => {
    const harness = makeHarness({
      rows: [presentationRow({ status: 'ready' })],
      latest: [event('turn.completed', { ts: '2026-08-25T23:59:00.000Z' })],
    })
    await harness.viewer.reconcile('start')
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: true },
          presentation: { operatorAttachable: true, viewerRequested: false },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    await harness.viewer.handleEvent(event('turn.started'))
    expect(harness.ensureCalls).toHaveLength(0)
    expect(harness.reads).toEqual({ presentation: 1, latest: 1 })
  })

  test('streamed surface ownership and nested metadata reach only the current live TTY', async () => {
    const harness = makeHarness({
      rows: [presentationRow(), presentationRow({ runtimeId: 'rt-2' })],
      clients: ['/dev/live'],
      panes: [
        { surfaceId: 'pane1', runtimeId: 'rt-1', hostSessionId: 'hs-1', generation: 1 },
        { surfaceId: 'pane2', runtimeId: 'rt-2', hostSessionId: 'hs-1', generation: 1 },
      ],
    })
    await harness.viewer.reconcile('start')
    const surface = { surfaceKind: 'ghostty', surfaceId: 'operator', clientTty: '/dev/live' }
    await harness.viewer.handleEvent(event('surface.bound', { payload: surface }))
    expect(harness.terminalTitleCalls).toHaveLength(1)
    await harness.viewer.handleEvent(
      event('surface.rebound', {
        runtimeId: 'rt-2',
        payload: { ...surface, previousRuntimeId: 'rt-1' },
      })
    )
    expect(harness.terminalTitleCalls).toHaveLength(2)
    await harness.viewer.handleEvent(
      event('runtime.presentation', {
        payload: {
          invocation: { operatorAttachPending: false },
          presentation: { operatorAttachable: true, viewerRequested: true },
          tmux: { socketPath: '/tmp/viewer.sock', attachTarget: 'viewer:tui' },
        },
      })
    )
    expect(harness.terminalTitleCalls).toHaveLength(2)
    await harness.viewer.handleEvent(
      event('surface.unbound', { runtimeId: 'rt-2', payload: surface })
    )
    expect(harness.terminalTitleCalls).toHaveLength(2)
    await harness.viewer.handleEvent(
      event('session.metadata.changed', {
        payload: { key: 'appearance.terminalBg', resolved: { value: '#123456', source: 'api' } },
      })
    )
    expect(harness.backgroundCalls.slice(-2).map((call) => call.hex)).toEqual([
      '#123456',
      '#123456',
    ])
    expect(harness.terminalTitleCalls).toHaveLength(2)
    expect(harness.reads).toEqual({ presentation: 1, latest: 1 })
  })
})
