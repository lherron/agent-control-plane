/**
 * T-10826: with non-task management disabled, the viewer mints no pane for a
 * new session whose scope is not a wrkq task (`primary`, roster slots, named
 * lanes). Task scopes (`:task:T-XXXXX`) mint as before, and a pane that already
 * exists for a non-task scope is still reused rather than orphaned.
 */
import { describe, expect, it } from 'bun:test'
import { fixtureIdentity } from './session-identity-fixture.js'

import {
  HrcViewer,
  type HrcViewerClient,
  MANAGE_NON_TASK_SESSIONS,
  type ViewerGhostmux,
  type ViewerLog,
} from '../viewer.js'

const TASK_SCOPE = 'agent:clod:project:agent-control-plane:task:T-10826'
const PRIMARY_SCOPE = 'agent:clod:project:agent-control-plane:task:primary'
const LANE_SCOPE = 'agent:mable:project:agent-control-plane:task:minisvc'

type Event = Parameters<HrcViewer['handleEvent']>[0]

function presentationEvent(scopeRef: string): Event {
  return {
    hrcSeq: 1,
    eventId: 'evt-1',
    ts: '2026-10-13T12:00:00.000Z',
    hostSessionId: 'hs-1',
    scopeRef,
    laneRef: 'main',
    generation: 1,
    runtimeId: 'rt-1',
    category: 'runtime',
    eventKind: 'runtime.presentation',
    replayed: false,
    payload: {
      invocation: { operatorAttachPending: false },
      presentation: { operatorAttachable: true, viewerRequested: true },
      tmux: { socketPath: '/tmp/t10826.sock', attachTarget: 'sess:tui' },
    },
  } as Event
}

function makeHarness(
  scopeRef: string,
  options: { manageNonTaskSessions?: boolean; existingPane?: boolean } = {}
) {
  const rows = [
    {
      runtimeId: 'rt-1',
      hostSessionId: 'hs-1',
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'busy',
      identity: fixtureIdentity(scopeRef),
      presentation: { operatorAttachable: true, viewerRequested: true },
      tmux: { socketPath: '/tmp/t10826.sock', attachTarget: 'sess:tui' },
    },
  ]
  const results: string[] = []
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const client = {
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
      return { ok: true as const, runtimes: rows }
    },
  } as unknown as HrcViewerClient
  // Mirrors GhostmuxManager: an existing pane is reused without consulting the
  // veto; only the create branch asks it.
  const ghostmux: ViewerGhostmux = {
    async ensureHeadlessViewer(opts) {
      if (options.existingPane) {
        results.push('reused')
        return { status: 'reused', surfaceId: 'surface-1', tabKey: 'tab' }
      }
      if (opts.skipCreateWhen !== undefined && (await opts.skipCreateWhen())) {
        results.push('skipped')
        return { status: 'skipped', reason: 'create_vetoed' }
      }
      results.push('created')
      return { status: 'created', surfaceId: 'surface-1', tabKey: 'tab' }
    },
    async findHeadlessViewerSurfaceByRuntimeId() {
      return null
    },
    async listHeadlessViewerPanes() {
      return []
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
    now: () => Date.parse('2026-10-13T12:00:00.000Z'),
    schedule() {
      return {} as ReturnType<typeof setTimeout>
    },
    clearScheduled() {},
    async probeTmuxClients() {
      return []
    },
    async readTaskTitles() {
      return new Map<string, string>()
    },
    async resolveTaskSlug() {
      return null
    },
    ...(options.manageNonTaskSessions === undefined
      ? {}
      : { manageNonTaskSessions: options.manageNonTaskSessions }),
  })
  return { viewer, results, logs }
}

describe('T-10826 task-only pane management', () => {
  it('ships with non-task management disabled', () => {
    expect(MANAGE_NON_TASK_SESSIONS).toBe(false)
  })

  it('a new task session still mints a pane', async () => {
    const harness = makeHarness(TASK_SCOPE)
    await harness.viewer.handleEvent(presentationEvent(TASK_SCOPE))
    expect(harness.results).toEqual(['created'])
  })

  for (const scope of [PRIMARY_SCOPE, LANE_SCOPE]) {
    it(`a new non-task session (${scope}) mints nothing and says why`, async () => {
      const harness = makeHarness(scope)
      await harness.viewer.handleEvent(presentationEvent(scope))
      expect(harness.results).toEqual(['skipped'])
      expect(
        harness.logs.find((entry) => entry.event === 'broker_headless_viewer.skipped_non_task')
          ?.fields
      ).toMatchObject({ runtimeId: 'rt-1', scopeRef: scope })
      expect(
        harness.logs.some(
          (entry) => entry.event === 'broker_headless_viewer.skipped_operator_attached'
        )
      ).toBe(false)
    })
  }

  it('reconcile does not mint a non-task pane either', async () => {
    const harness = makeHarness(PRIMARY_SCOPE)
    await harness.viewer.reconcile('test')
    expect(harness.results).toEqual(['skipped'])
  })

  it('an existing non-task pane is still reused', async () => {
    const harness = makeHarness(PRIMARY_SCOPE, { existingPane: true })
    await harness.viewer.handleEvent(presentationEvent(PRIMARY_SCOPE))
    expect(harness.results).toEqual(['reused'])
  })

  it('enabling the flag restores non-task creates', async () => {
    const harness = makeHarness(PRIMARY_SCOPE, { manageNonTaskSessions: true })
    await harness.viewer.handleEvent(presentationEvent(PRIMARY_SCOPE))
    expect(harness.results).toEqual(['created'])
  })
})
