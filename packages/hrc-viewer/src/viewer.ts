import { isRecord } from './ghostmux-client.js'
import { deriveHeadlessSessionIdentity } from './ghostmux-identity.js'
import {
  HeadlessViewerStatusProjector,
  viewerStateForEventKind,
  viewerStateForRuntimeStatus,
} from './headless-viewer-status.js'
import { type HrcptyClientProbe, createHrcptyClientProbe } from './hrcpty-clients.js'
import { type TmuxClientProbe, createTmuxClientProbe } from './tmux-clients.js'
import {
  type HrcViewerClient,
  type HrcViewerOptions,
  type HrcptyPresentation,
  type LifecycleEvent,
  type PresentationRuntimeRow,
  type ViewerGhostmux,
  type ViewerLog,
  type ViewerWarn,
  normalizePresentationLaneRef,
} from './viewer-contracts.js'
import { watchViewerEvents } from './viewer-event-stream.js'
import { ViewerPanePresentation } from './viewer-pane-presentation.js'
import { ViewerPaneReaper } from './viewer-pane-reaper.js'
import { defaultTaskSlugResolver, defaultTaskTitleReader } from './wrkq-task-label.js'

export type {
  HrcViewerClient,
  HrcViewerOptions,
  ViewerGhostmux,
  ViewerLog,
} from './viewer-contracts.js'

/** What the viewer pane attaches to: a tmux target, or an hrcpty supervisor socket. */
type ViewerAttach =
  | { transport: 'tmux'; socketPath: string; attachTarget: string }
  | { transport: 'hrcpty'; socketPath: string; attachCommand: string }

/**
 * Feature flag (T-10826): when false, the viewer mints no pane for a new session
 * whose scope is not a wrkq task (`primary`, roster slots, named lanes such as
 * `minisvc`). Only the create is gated: a pane that already exists for such a
 * scope is still reused, painted and reaped, so nothing is orphaned when the
 * flag flips. Set true to restore pane management for every session.
 */
export const MANAGE_NON_TASK_SESSIONS = false

const DEFAULT_LINGER_SECONDS = 300
/**
 * Give the fenced reaper time to close the pane and collapse the tab before
 * session-report exits on its own. Both clocks start at runtime exit (T-08115).
 */
const REAP_HANDOFF_MARGIN_SECONDS = 15
const DEFAULT_RECONCILE_INTERVAL_MS = 15 * 60 * 1_000
/**
 * A seat idle longer than this is dormant: reconcile mints no pane for it, so a
 * viewer restart does not reopen every seat that ran in the last few days. Its
 * next turn re-attaches it (see `handleEvent`).
 */
const DORMANT_AFTER_MS = 12 * 60 * 60 * 1_000
const TERMINAL_EVENT_KINDS = new Set([
  'runtime.terminated',
  'runtime.dead',
  'runtime.stale',
  'runtime.crashed',
])

export function parseViewerLingerSeconds(
  value = process.env['HRC_VIEWER_LINGER_SECONDS'],
  fallback = DEFAULT_LINGER_SECONDS
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function asHrcptyPresentation(value: unknown): HrcptyPresentation | undefined {
  const record = asRecord(value)
  const socketPath = record['socketPath']
  const attachCommand = record['attachCommand']
  return typeof socketPath === 'string' &&
    socketPath !== '' &&
    typeof attachCommand === 'string' &&
    attachCommand !== ''
    ? { socketPath, attachCommand }
    : undefined
}

function viewerAttachFor(row: PresentationRuntimeRow): ViewerAttach | undefined {
  if (row.tmux !== undefined) return { transport: 'tmux', ...row.tmux }
  const hrcpty = asHrcptyPresentation(row.hrcpty)
  return hrcpty === undefined ? undefined : { transport: 'hrcpty', ...hrcpty }
}

function attachCommandFor(
  row: PresentationRuntimeRow,
  attach: ViewerAttach,
  lingerSeconds: number
): string {
  return [
    // rusthrc's hrcpty attachCommand is already the shell-quoted attach argv.
    attach.transport === 'tmux'
      ? `tmux -S ${shellQuote(attach.socketPath)} attach-session -t ${shellQuote(attach.attachTarget)}`
      : attach.attachCommand,
    `hrc monitor session-report --runtime ${shellQuote(row.runtimeId)} --scope ${shellQuote(row.scopeRef)} --wait-key --wait-timeout ${lingerSeconds + REAP_HANDOFF_MARGIN_SECONDS}`,
    'exit',
  ].join('; ')
}

function eventTimeMs(event: LifecycleEvent): number | undefined {
  const parsed = Date.parse(event.ts)
  return Number.isFinite(parsed) ? parsed : undefined
}

function paneKeyFor(
  row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef' | 'identity'>
): string {
  return deriveHeadlessSessionIdentity(
    row.scopeRef,
    normalizePresentationLaneRef(row.laneRef),
    row.identity
  ).paneKey
}

function latestByRuntime(events: LifecycleEvent[]): Map<string, LifecycleEvent> {
  const map = new Map<string, LifecycleEvent>()
  for (const event of events) {
    if (event.runtimeId !== undefined) map.set(event.runtimeId, event)
  }
  return map
}

/** Event-driven presentation projection described by sidecar law §4. */
export class HrcViewer {
  private readonly client: HrcViewerClient
  private readonly ghostmux: ViewerGhostmux
  private readonly log: ViewerLog
  private readonly lingerSeconds: number
  private readonly reconcileIntervalMs: number
  private readonly reconnectDelaysMs: readonly number[] | undefined
  private readonly streamStableAfterMs: number | undefined
  private readonly now: () => number
  private readonly reaper: ViewerPaneReaper
  private readonly absentSince = new Map<string, number>()
  /** Runtimes reconcile declined to attach because they were dormant. */
  private readonly dormantRuntimeIds = new Set<string>()
  /** Store-only snapshot, advanced by the bounded event stream between repairs. */
  private readonly presentationRows = new Map<string, PresentationRuntimeRow>()
  private readonly latestEvents = new Map<string, LifecycleEvent>()
  private readonly missingRuntimeIds = new Set<string>()
  private snapshotRevision = 0
  private reconcileInFlight: Promise<void> | undefined
  private stopped = false
  private readonly statusProjector: HeadlessViewerStatusProjector
  private readonly probeTmuxClients: TmuxClientProbe
  private readonly probeHrcptyClients: HrcptyClientProbe
  private readonly panePresentation: ViewerPanePresentation
  private readonly manageNonTaskSessions: boolean
  constructor(options: HrcViewerOptions) {
    this.client = options.client
    this.ghostmux = options.ghostmux
    this.log = options.log ?? (() => undefined)
    this.lingerSeconds =
      options.lingerSeconds ?? parseViewerLingerSeconds(process.env['HRC_VIEWER_LINGER_SECONDS'])
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
    this.reconnectDelaysMs = options.reconnectDelaysMs
    this.streamStableAfterMs = options.streamStableAfterMs
    this.now = options.now ?? Date.now
    this.reaper = new ViewerPaneReaper(
      this.ghostmux,
      this.lingerSeconds,
      () => this.now(),
      this.log,
      this.warn,
      options
    )
    this.probeTmuxClients = options.probeTmuxClients ?? createTmuxClientProbe()
    this.probeHrcptyClients = options.probeHrcptyClients ?? createHrcptyClientProbe()
    const resolveTaskSlug = options.resolveTaskSlug ?? defaultTaskSlugResolver()
    this.panePresentation = new ViewerPanePresentation(
      this.ghostmux,
      (socketPath, attachTarget) => this.probeTmuxClients(socketPath, attachTarget),
      resolveTaskSlug,
      options.readTaskTitles ?? defaultTaskTitleReader(),
      this.warn
    )
    this.manageNonTaskSessions = options.manageNonTaskSessions ?? MANAGE_NON_TASK_SESSIONS
    this.statusProjector = new HeadlessViewerStatusProjector({
      resolveSurfaceId: (runtimeId) =>
        this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(runtimeId),
      resolveSurfaceIds: (runtimeId) => this.resolveStatusSurfaceIds(runtimeId),
      applyStatusBar: (surfaceId, spec) => this.ghostmux.setStatusBar(surfaceId, spec),
      resolveSlug: resolveTaskSlug,
      resolveSession: (runtimeId) => this.currentPresentationRuntime(runtimeId),
      onError: (error) => this.warn('broker_headless_viewer.status_failed', error),
    })
  }

  async run(signal?: AbortSignal | undefined): Promise<void> {
    this.stopped = false
    const stop = () => {
      this.stopped = true
    }
    signal?.addEventListener('abort', stop, { once: true })
    const reconcileTimer = setInterval(() => void this.reconcile('timer'), this.reconcileIntervalMs)
    if (typeof reconcileTimer === 'object' && 'unref' in reconcileTimer) reconcileTimer.unref()

    try {
      await watchViewerEvents(
        {
          client: this.client,
          reconnectDelaysMs: this.reconnectDelaysMs,
          streamStableAfterMs: this.streamStableAfterMs,
          now: () => this.now(),
          isStopped: () => this.isStopped(signal),
          reconcile: (reason) => this.reconcile(reason),
          handleEvent: (event) => this.handleEvent(event),
          log: this.log,
          warn: this.warn,
        },
        signal
      )
    } finally {
      this.stopped = true
      clearInterval(reconcileTimer)
      signal?.removeEventListener('abort', stop)
      this.statusProjector.dispose()
      this.reaper.clear()
    }
  }

  async reconcile(
    reason: 'start' | 'reconnect' | 'timer' | 'stream_reset' | 'dormant_woke'
  ): Promise<void> {
    if (this.reconcileInFlight !== undefined) return this.reconcileInFlight
    const operation = this.reconcileOnce(reason).finally(() => {
      if (this.reconcileInFlight === operation) this.reconcileInFlight = undefined
    })
    this.reconcileInFlight = operation
    return operation
  }

  async handleEvent(event: LifecycleEvent): Promise<void> {
    // A pending repair owns the snapshot until it has finished painting it.
    // Fold streamed changes afterwards so the response cannot erase them.
    await this.reconcileInFlight
    if (event.runtimeId !== undefined) this.missingRuntimeIds.delete(event.runtimeId)
    if (event.eventKind === 'session.metadata.changed') {
      await this.handleMetadataEvent(event)
      return
    }
    if (event.eventKind.startsWith('surface.')) {
      await this.handleSurfaceEvent(event)
      return
    }
    const state = viewerStateForEventKind(event.eventKind)
    if (event.runtimeId !== undefined && state !== null) {
      // Lifecycle facts alone do not request presentation. A missing row only
      // needs repair when an owned pane still references that runtime.
      if (
        !this.presentationRows.has(event.runtimeId) &&
        (await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(event.runtimeId)) === null
      )
        return
      const row = await this.currentPresentationRuntime(event.runtimeId)
      const previous = this.latestEvents.get(event.runtimeId)
      if (previous !== undefined && TERMINAL_EVENT_KINDS.has(previous.eventKind)) return
      this.latestEvents.set(event.runtimeId, event)
      if (row !== undefined) {
        row.status = state === 'exited' ? 'terminated' : state === 'idle' ? 'ready' : 'busy'
      }
      this.statusProjector.observe(event)
      if (
        state === 'running' &&
        this.dormantRuntimeIds.delete(event.runtimeId) &&
        row?.presentation?.viewerRequested === true &&
        row.presentation.operatorAttachable === true
      ) {
        await this.ensurePane(row, event)
        return
      }
    }

    if (event.eventKind === 'runtime.presentation') {
      await this.handlePresentationEvent(event)
      return
    }
    if (TERMINAL_EVENT_KINDS.has(event.eventKind) && event.runtimeId !== undefined) {
      const surfaceId = await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(event.runtimeId)
      if (surfaceId !== null) {
        // The task title describes a LIVE seat. A pane lingers for minutes after
        // its runtime ends and may be recycled for another occupant, so drop the
        // title at the terminal event rather than leaving it up until the reap.
        await this.panePresentation.clearSecondaryBar(surfaceId)
        const occurredAt = eventTimeMs(event) ?? this.now()
        this.reaper.schedule(surfaceId, event.runtimeId, event.scopeRef, occurredAt)
      }
    }
  }

  private async handlePresentationEvent(event: LifecycleEvent): Promise<void> {
    const payload = asRecord(event.payload)
    const invocation = asRecord(payload['invocation'])
    const presentation = asRecord(payload['presentation'])
    const tmux = asRecord(payload['tmux'])
    const socketPath = typeof tmux['socketPath'] === 'string' ? tmux['socketPath'] : undefined
    const attachTarget = typeof tmux['attachTarget'] === 'string' ? tmux['attachTarget'] : undefined
    const hrcpty = asHrcptyPresentation(payload['hrcpty'])
    const current =
      event.runtimeId === undefined
        ? undefined
        : await this.currentPresentationRuntime(event.runtimeId)
    const previous =
      event.runtimeId === undefined ? undefined : this.latestEvents.get(event.runtimeId)
    if (previous !== undefined && TERMINAL_EVENT_KINDS.has(previous.eventKind)) return
    const attach =
      socketPath !== undefined && attachTarget !== undefined
        ? { tmux: { socketPath, attachTarget } }
        : hrcpty !== undefined
          ? { hrcpty }
          : undefined
    // Persisted decision, including suppressed invocations. Only the create
    // below is vetoed by operatorAttachPending, never the retained projection.
    const row: PresentationRuntimeRow | undefined =
      event.runtimeId === undefined
        ? undefined
        : {
            ...current,
            identity: current?.identity ?? event.identity,
            operatorSurfaces: current?.operatorSurfaces ?? [],
            runtimeId: event.runtimeId,
            hostSessionId: event.hostSessionId,
            scopeRef: event.scopeRef,
            laneRef: normalizePresentationLaneRef(event.laneRef),
            generation: event.generation,
            status: current?.status ?? 'busy',
            presentation: {
              operatorAttachable: presentation['operatorAttachable'] === true,
              viewerRequested: presentation['viewerRequested'] === true,
              ...(typeof presentation['viewerWindow'] === 'string'
                ? { viewerWindow: presentation['viewerWindow'] }
                : {}),
            },
            tmux: undefined,
            hrcpty: undefined,
            ...attach,
            title: typeof payload['title'] === 'string' ? payload['title'] : undefined,
          }
    if (row !== undefined) {
      this.presentationRows.set(row.runtimeId, row)
      this.missingRuntimeIds.delete(row.runtimeId)
    }
    if (invocation['operatorAttachPending'] === true) {
      this.log('INFO', 'broker_headless_viewer.skipped_operator_attach_pending', {
        runtimeId: event.runtimeId,
        scopeRef: event.scopeRef,
      })
      return
    }
    if (presentation['viewerRequested'] !== true || presentation['operatorAttachable'] !== true) {
      this.log('INFO', 'broker_headless_viewer.skipped_no_presentation', {
        runtimeId: event.runtimeId,
        scopeRef: event.scopeRef,
      })
      return
    }
    if (row === undefined || attach === undefined) {
      this.log('INFO', 'broker_headless_viewer.skipped_no_socket', {
        runtimeId: event.runtimeId,
        scopeRef: event.scopeRef,
      })
      return
    }
    await this.ensurePane(row, previous)
  }

  private async reconcileOnce(reason: string): Promise<void> {
    try {
      const [response, latest, panes] = await Promise.all([
        this.client.listPresentationRuntimes(),
        this.client.listLatestEventBySession(),
        this.ghostmux.listHeadlessViewerPanes(),
      ])
      const rows = response.runtimes.map((row) => structuredClone(row))
      this.snapshotRevision += 1
      this.presentationRows.clear()
      this.missingRuntimeIds.clear()
      const rowsByRuntime = new Map(rows.map((row) => [row.runtimeId, row]))
      for (const [runtimeId, row] of rowsByRuntime) this.presentationRows.set(runtimeId, row)
      const eventsByRuntime = latestByRuntime(latest)
      this.latestEvents.clear()
      for (const [runtimeId, event] of eventsByRuntime) this.latestEvents.set(runtimeId, event)
      const rowsByPaneKey = new Map(rows.map((row) => [paneKeyFor(row), row]))
      const adoptedSurfaceIds = new Set<string>()
      // One batched read for the whole fleet, BEFORE any pane is stamped, so
      // every pane in this pass is titled from the same fresh answer.
      await this.panePresentation.refreshTaskTitles(rows.map((row) => row.identity))

      for (const pane of panes) {
        const direct = pane.runtimeId === undefined ? undefined : rowsByRuntime.get(pane.runtimeId)
        const replacement = pane.paneKey === undefined ? undefined : rowsByPaneKey.get(pane.paneKey)
        const row = direct ?? replacement
        if (row !== undefined) {
          this.absentSince.delete(pane.runtimeId ?? row.runtimeId)
          adoptedSurfaceIds.add(pane.surfaceId)
          if (
            pane.runtimeId !== row.runtimeId ||
            pane.hostSessionId !== row.hostSessionId ||
            pane.generation !== row.generation
          ) {
            // Adoption must replace the attach process as well as runtime metadata.
            await this.ensurePane(row, eventsByRuntime.get(row.runtimeId), false)
          }
          await this.panePresentation.paint(pane.surfaceId, row, eventsByRuntime.get(row.runtimeId))
          continue
        }

        // No presentation row: this pane is terminal or orphaned and is headed
        // for the reaper. Same reason as the terminal-event path above.
        await this.panePresentation.clearSecondaryBar(pane.surfaceId)
        if (pane.runtimeId === undefined) continue
        const latestEvent = eventsByRuntime.get(pane.runtimeId)
        const terminalAt =
          latestEvent !== undefined && TERMINAL_EVENT_KINDS.has(latestEvent.eventKind)
            ? (eventTimeMs(latestEvent) ?? this.now())
            : (this.absentSince.get(pane.runtimeId) ?? this.now())
        this.absentSince.set(pane.runtimeId, terminalAt)
        this.reaper.schedule(
          pane.surfaceId,
          pane.runtimeId,
          pane.scopeRef ?? latestEvent?.scopeRef ?? 'unknown',
          terminalAt
        )
      }

      for (const row of rows) {
        const pane = panes.find(
          (candidate) =>
            adoptedSurfaceIds.has(candidate.surfaceId) &&
            (candidate.runtimeId === row.runtimeId || candidate.paneKey === paneKeyFor(row))
        )
        if (pane !== undefined) continue
        // Upgrade law §5.5: a missing record is adopt-only. Never infer intent.
        if (
          row.presentation?.viewerRequested !== true ||
          row.presentation.operatorAttachable !== true ||
          viewerAttachFor(row) === undefined
        ) {
          await this.panePresentation.paint(undefined, row, eventsByRuntime.get(row.runtimeId))
          continue
        }
        const latestEvent = eventsByRuntime.get(row.runtimeId)
        if (this.isDormant(row, latestEvent)) {
          if (!this.dormantRuntimeIds.has(row.runtimeId)) {
            this.dormantRuntimeIds.add(row.runtimeId)
            this.log('INFO', 'broker_headless_viewer.skipped_dormant', {
              runtimeId: row.runtimeId,
              scopeRef: row.scopeRef,
              lastEventAt: latestEvent?.ts,
            })
          }
          continue
        }
        this.dormantRuntimeIds.delete(row.runtimeId)
        await this.ensurePane(row, latestEvent)
      }
      for (const runtimeId of this.dormantRuntimeIds) {
        if (!rowsByRuntime.has(runtimeId)) this.dormantRuntimeIds.delete(runtimeId)
      }
      this.log('INFO', 'broker_headless_viewer.reconciled', {
        reason,
        runtimes: rows.length,
        panes: panes.length,
      })
    } catch (error) {
      this.warn('broker_headless_viewer.reconcile_failed', error, { reason })
    }
  }

  /**
   * Idle past DORMANT_AFTER_MS by its latest lifecycle event. A starting/busy row
   * is active whatever that event says, and an unknown age fails open (mints).
   */
  private isDormant(row: PresentationRuntimeRow, latestEvent: LifecycleEvent | undefined): boolean {
    if (viewerStateForRuntimeStatus(row.status) === 'running') return false
    const lastAt = latestEvent === undefined ? undefined : eventTimeMs(latestEvent)
    return lastAt !== undefined && this.now() - lastAt > DORMANT_AFTER_MS
  }

  private async ensurePane(
    row: PresentationRuntimeRow,
    latestEvent?: LifecycleEvent | undefined,
    paint = true
  ): Promise<void> {
    const attach = viewerAttachFor(row)
    if (attach === undefined) return
    const attachCommand = attachCommandFor(row, attach, this.lingerSeconds)
    // Record the tmux TTYs or hrcpty client count that vetoed pane creation.
    let operatorClients: readonly string[] | number = []
    // T-10826: classified the way ghostmux groups the pane, so the gate and the
    // tab it would have landed in can never disagree about what a task is.
    const nonTaskVetoed =
      !this.manageNonTaskSessions &&
      !deriveHeadlessSessionIdentity(
        row.scopeRef,
        normalizePresentationLaneRef(row.laneRef),
        row.identity
      ).tab.tabKey.startsWith('task:')
    const result = await this.ghostmux.ensureHeadlessViewer({
      scopeRef: row.scopeRef,
      identity: row.identity,
      laneRef: normalizePresentationLaneRef(row.laneRef),
      runtimeId: row.runtimeId,
      hostSessionId: row.hostSessionId,
      generation: row.generation,
      attachCommand,
      attachTarget:
        attach.transport === 'tmux'
          ? { socketPath: attach.socketPath, attachTarget: attach.attachTarget }
          : { socketPath: attach.socketPath },
      windowKey: row.presentation?.viewerWindow,
      // Ghostmux calls this only for a new pane. Existing clients belong to
      // operators and the default probes allow creation when detection fails.
      skipCreateWhen: async () => {
        if (nonTaskVetoed) return true
        if (attach.transport === 'hrcpty') {
          operatorClients = await this.probeHrcptyClients(attach.socketPath)
          return operatorClients > 0
        }
        operatorClients = await this.probeTmuxClients(attach.socketPath, attach.attachTarget)
        return operatorClients.length > 0
      },
    })
    if (result.status === 'skipped') {
      if (nonTaskVetoed) {
        this.log('INFO', 'broker_headless_viewer.skipped_non_task', {
          runtimeId: row.runtimeId,
          scopeRef: row.scopeRef,
        })
      } else {
        this.log('INFO', 'broker_headless_viewer.skipped_operator_attached', {
          runtimeId: row.runtimeId,
          scopeRef: row.scopeRef,
          ...(attach.transport === 'tmux'
            ? { attachTarget: attach.attachTarget }
            : { transport: attach.transport, socketPath: attach.socketPath }),
          clients: operatorClients,
        })
      }
      const current = await this.currentPresentationRuntime(row.runtimeId)
      await this.panePresentation.paint(undefined, current ?? row, latestEvent)
      return
    }
    if (paint && (result.status === 'created' || result.status === 'reused')) {
      const current = await this.currentPresentationRuntime(row.runtimeId)
      await this.panePresentation.paint(result.surfaceId, current ?? row, latestEvent)
    }
    this.log(
      result.status === 'failed' ? 'WARN' : 'INFO',
      `broker_headless_viewer.${result.status}`,
      {
        runtimeId: row.runtimeId,
        scopeRef: row.scopeRef,
        ...(result.status === 'failed' ? { error: result.error } : { surfaceId: result.surfaceId }),
      }
    )
  }

  /** Missing references retain the existing full recovery, once per snapshot. */
  private async currentPresentationRuntime(
    runtimeId: string
  ): Promise<PresentationRuntimeRow | undefined> {
    const row = this.presentationRows.get(runtimeId)
    if (row !== undefined) return row
    if (this.missingRuntimeIds.has(runtimeId)) return undefined
    const latest = this.latestEvents.get(runtimeId)
    if (latest !== undefined && TERMINAL_EVENT_KINDS.has(latest.eventKind)) return undefined
    const revision = this.snapshotRevision
    if (revision === 0) {
      // handleEvent is also a standalone entry point. Before run's bootstrap,
      // keep its store-only lookup semantics; do not create unrelated panes.
      try {
        const response = await this.client.listPresentationRuntimes()
        for (const candidate of response.runtimes) {
          this.presentationRows.set(candidate.runtimeId, structuredClone(candidate))
        }
        this.snapshotRevision += 1
      } catch (error) {
        this.warn('broker_headless_viewer.presentation_read_failed', error, { runtimeId })
      }
    } else {
      await this.reconcile('stream_reset')
    }
    const recovered = this.presentationRows.get(runtimeId)
    if (recovered === undefined && this.snapshotRevision !== revision) {
      this.missingRuntimeIds.add(runtimeId)
    }
    return recovered
  }

  private async repaintRuntime(row: PresentationRuntimeRow): Promise<void> {
    const latest = this.latestEvents.get(row.runtimeId)
    if (latest !== undefined && TERMINAL_EVENT_KINDS.has(latest.eventKind)) return
    const surfaceId = await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(row.runtimeId)
    await this.panePresentation.paint(surfaceId, row, latest)
  }

  private async handleMetadataEvent(event: LifecycleEvent): Promise<void> {
    const payload = asRecord(event.payload)
    const key = payload['key']
    if (
      typeof key !== 'string' ||
      !/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){0,3}$/.test(key) ||
      key.split('.').some((part) => part === 'constructor' || part === 'prototype') ||
      !Object.hasOwn(payload, 'resolved')
    ) {
      await this.reconcile('stream_reset')
      return
    }
    const rows = [...this.presentationRows.values()].filter(
      (row) =>
        row.scopeRef === event.scopeRef &&
        normalizePresentationLaneRef(row.laneRef) === normalizePresentationLaneRef(event.laneRef)
    )
    const resolved = payload['resolved']
    if (resolved !== null && !Object.hasOwn(asRecord(resolved), 'value')) {
      await this.reconcile('stream_reset')
      return
    }
    // Metadata is continuity state, not a request to present a seat. A later
    // runtime.presentation loads the current store metadata in its own repair.
    const parents = key.split('.').slice(0, -1)
    const leaf = key.slice(key.lastIndexOf('.') + 1)
    for (const row of rows) {
      const metadata = structuredClone(row.metadata ?? {})
      let target: Record<string, unknown> = metadata
      for (const part of parents) {
        const child = { ...asRecord(target[part]) }
        target[part] = child
        target = child
      }
      if (resolved === null) delete target[leaf]
      else target[leaf] = asRecord(resolved)['value']
      row.metadata = metadata
      if (key === 'title')
        row.title = typeof metadata.title === 'string' ? metadata.title : undefined
      await this.repaintRuntime(row)
    }
  }

  private async handleSurfaceEvent(event: LifecycleEvent): Promise<void> {
    if (!['surface.bound', 'surface.rebound', 'surface.unbound'].includes(event.eventKind)) return
    const payload = asRecord(event.payload)
    if (payload['surfaceKind'] !== 'ghostty') return
    const surfaceId = payload['surfaceId']
    if (typeof surfaceId !== 'string' || event.runtimeId === undefined) {
      await this.reconcile('stream_reset')
      return
    }
    // Retirement never needs discovery of a runtime we do not present.
    const row =
      event.eventKind === 'surface.unbound'
        ? this.presentationRows.get(event.runtimeId)
        : await this.currentPresentationRuntime(event.runtimeId)
    // A rebound changes ownership even if the destination runtime is missing.
    for (const retained of this.presentationRows.values()) {
      retained.operatorSurfaces = (retained.operatorSurfaces ?? []).filter(
        (surface) => surface.surfaceId !== surfaceId
      )
    }
    if (row === undefined) return
    if (event.eventKind !== 'surface.unbound' && typeof payload['clientTty'] === 'string') {
      row.operatorSurfaces.push({ surfaceId, clientTty: payload['clientTty'] })
    }
    await this.repaintRuntime(row)
  }

  /** Retained binding plus a fresh exact-TTY probe fences lifecycle writes. */
  private async resolveStatusSurfaceIds(runtimeId: string): Promise<readonly string[]> {
    let paneSurfaceId: string | null = null
    try {
      paneSurfaceId = await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(runtimeId)
    } catch (error) {
      this.warn('broker_headless_viewer.status_surface_lookup_failed', error, { runtimeId })
    }
    if (paneSurfaceId === null && !this.presentationRows.has(runtimeId)) return []
    const row = await this.currentPresentationRuntime(runtimeId)
    return row === undefined
      ? paneSurfaceId === null
        ? []
        : [paneSurfaceId]
      : await this.panePresentation.presentationSurfaceIds(paneSurfaceId, row)
  }

  private readonly warn: ViewerWarn = (event, error, fields = {}) => {
    this.log('WARN', event, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private isStopped(signal?: AbortSignal): boolean {
    return this.stopped || signal?.aborted === true
  }
}
