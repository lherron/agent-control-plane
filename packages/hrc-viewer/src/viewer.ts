import type { HrcClient, HrcEventTail } from 'hrc-sdk'

import {
  type GhostmuxSecondaryStatusBarSpec,
  type GhostmuxStatusBarSpec,
  type HeadlessReapResult,
  type HeadlessViewerPane,
  type HeadlessViewerResult,
  defaultHeadlessPaneTitle,
  deriveHeadlessSessionIdentity,
} from './ghostmux.js'
import {
  HeadlessViewerStatusProjector,
  renderSecondaryStatusBar,
  renderStatusBar,
  viewerStateForEventKind,
  viewerStateForRuntimeStatus,
  viewerTerminalBg,
} from './headless-viewer-status.js'
import { type TmuxClientProbe, createTmuxClientProbe } from './tmux-clients.js'
import {
  type TaskTitleReader,
  defaultTaskSlugResolver,
  defaultTaskTitleReader,
  extractTaskIdFromScope,
} from './wrkq-task-label.js'

export type HrcViewerClient = Pick<
  HrcClient,
  | 'health'
  | 'tailEvents'
  | 'watchBoundedEvents'
  | 'listLatestEventBySession'
  | 'listPresentationRuntimes'
>

type LifecycleEvent = HrcEventTail['events'][number]
type HrcPresentationRuntimeRow = Awaited<
  ReturnType<HrcViewerClient['listPresentationRuntimes']>
>['runtimes'][number]
type OperatorSurface = { surfaceId: string; clientTty: string }
/** New HRC rows add this field; ACP stays compatible with its pinned SDK tuple. */
type PresentationRuntimeRow = HrcPresentationRuntimeRow & {
  operatorSurfaces?: readonly OperatorSurface[] | undefined
}

export type ViewerGhostmux = {
  ensureHeadlessViewer(options: {
    scopeRef: string
    laneRef?: string | undefined
    runtimeId: string
    hostSessionId?: string | undefined
    generation?: number | undefined
    attachCommand: string
    title?: string | undefined
    statusBar?: GhostmuxStatusBarSpec | undefined
    terminalBg?: string | undefined
    windowKey?: string | undefined
    skipCreateWhen?: (() => Promise<boolean>) | undefined
  }): Promise<HeadlessViewerResult>
  findHeadlessViewerSurfaceByRuntimeId(runtimeId: string): Promise<string | null>
  listHeadlessViewerPanes(): Promise<HeadlessViewerPane[]>
  rebindHeadlessViewerPane(
    surfaceId: string,
    options: {
      scopeRef: string
      laneRef?: string | undefined
      runtimeId: string
      hostSessionId: string
      generation: number
      windowKey?: string | undefined
    }
  ): Promise<void>
  setHeadlessViewerTitle(surfaceId: string, title: string): Promise<void>
  /** Generic presentation writes; these never stamp hrc_* metadata. */
  setTerminalTitle?(surfaceId: string, title: string): Promise<void>
  setTerminalBackground?(surfaceId: string, hex: string): Promise<void>
  setStatusBar(surfaceId: string, spec: GhostmuxStatusBarSpec): Promise<void>
  setSecondaryStatusBar(surfaceId: string, spec: GhostmuxSecondaryStatusBarSpec): Promise<void>
  hideSecondaryStatusBar(surfaceId: string): Promise<void>
  reapHeadlessAgentPane(surfaceId: string, runtimeId: string): Promise<HeadlessReapResult>
}

export type ViewerLog = (
  level: 'INFO' | 'WARN',
  event: string,
  fields?: Record<string, unknown>
) => void

export type HrcViewerOptions = {
  client: HrcViewerClient
  ghostmux: ViewerGhostmux
  log?: ViewerLog | undefined
  lingerSeconds?: number | undefined
  reconcileIntervalMs?: number | undefined
  reconnectDelaysMs?: readonly number[] | undefined
  /** How long a stream must survive before its end resets the backoff. */
  streamStableAfterMs?: number | undefined
  now?: (() => number) | undefined
  schedule?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined
  clearScheduled?: ((handle: ReturnType<typeof setTimeout>) => void) | undefined
  /**
   * Who is already attached to a runtime's tmux target (T-07711). Injected so
   * the operator-attached suppression is testable without a live tmux server.
   */
  probeTmuxClients?: TmuxClientProbe | undefined
  /** Batched wrkq task-title reader for the secondary bar (T-08331). Injected for tests. */
  readTaskTitles?: TaskTitleReader | undefined
}

const DEFAULT_LINGER_SECONDS = 300
/**
 * How much longer the pane waits before closing itself than the reaper waits
 * before closing it (T-08115).
 *
 * The pane's own command ends `session-report --wait-timeout <linger>; exit`,
 * and `scheduleReap` fires at `terminalAt + <linger>`. Given the same number,
 * those are the SAME deadline: the pane's clock starts when `tmux attach`
 * returns, which is the terminal event the reaper is also counting from. The
 * two were separated only by process-startup jitter, so which one closed the
 * pane was a coin flip — measured on 2026-09-06, the reaper won by 0.6s for
 * rt-49e5932f and lost five other races the same hour. Losing cost the fenced
 * reap its tab-collapse bookkeeping and logged a skip for a pane that had in
 * fact gone. A margin makes the reaper authoritative and leaves the pane's own
 * exit as the backstop for when the viewer is not running at all.
 */
const REAP_HANDOFF_MARGIN_SECONDS = 15
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1_000
const DEFAULT_RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000] as const
/**
 * How long `consumeStream` must survive before its end counts as a healthy
 * stream ending rather than a failed reconnect (T-08296).
 *
 * `watchBoundedEvents` is BOUNDED: it closes on its own, and the loop turns
 * every close into a throw. The failure counter therefore has to distinguish
 * "ran for a while, then ended" from "closed immediately, again" — the latter
 * is the shape that spins. Anything under this window escalates the backoff.
 */
const DEFAULT_STREAM_STABLE_AFTER_MS = 5_000
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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function normalizePresentationLaneRef(laneRef: string | undefined): string {
  if (laneRef === undefined || laneRef === '' || laneRef === 'main' || laneRef === 'lane:main') {
    return 'main'
  }
  return laneRef.startsWith('lane:') ? laneRef : `lane:${laneRef}`
}

function attachCommandFor(row: PresentationRuntimeRow, lingerSeconds: number): string | null {
  if (row.tmux === undefined) return null
  return [
    `tmux -S ${shellQuote(row.tmux.socketPath)} attach-session -t ${shellQuote(row.tmux.attachTarget)}`,
    `hrc monitor session-report --runtime ${shellQuote(row.runtimeId)} --scope ${shellQuote(row.scopeRef)} --wait-key --wait-timeout ${lingerSeconds + REAP_HANDOFF_MARGIN_SECONDS}`,
    'exit',
  ].join('; ')
}

function titleFor(row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef' | 'title'>): string {
  return (
    row.title ?? defaultHeadlessPaneTitle(row.scopeRef, normalizePresentationLaneRef(row.laneRef))
  )
}

function eventTimeMs(event: LifecycleEvent): number | undefined {
  const parsed = Date.parse(event.ts)
  return Number.isFinite(parsed) ? parsed : undefined
}

function paneKeyFor(row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef'>): string {
  return deriveHeadlessSessionIdentity(row.scopeRef, normalizePresentationLaneRef(row.laneRef))
    .paneKey
}

function latestByRuntime(events: LifecycleEvent[]): Map<string, LifecycleEvent> {
  const map = new Map<string, LifecycleEvent>()
  for (const event of events) {
    if (event.runtimeId !== undefined) map.set(event.runtimeId, event)
  }
  return map
}

/** Event-driven, stateless presentation projection described by sidecar law §4. */
export class HrcViewer {
  private readonly client: HrcViewerClient
  private readonly ghostmux: ViewerGhostmux
  private readonly log: ViewerLog
  private readonly lingerSeconds: number
  private readonly reconcileIntervalMs: number
  private readonly reconnectDelaysMs: readonly number[]
  private readonly streamStableAfterMs: number
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearScheduled: (handle: ReturnType<typeof setTimeout>) => void
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly absentSince = new Map<string, number>()
  private reconcileInFlight: Promise<void> | undefined
  private stopped = false
  private readonly statusProjector: HeadlessViewerStatusProjector
  private readonly probeTmuxClients: TmuxClientProbe
  private readonly readTaskTitles: TaskTitleReader
  /**
   * Last-known wrkq title per task id (T-08331). Refreshed in one batched read
   * per reconcile and NEVER evicted on a read failure — a deleted task, a wrkq
   * missing from PATH or a hung CLI must degrade to the title already on the
   * bar, never blank every pane at once.
   */
  private readonly taskTitles = new Map<string, string>()

  constructor(options: HrcViewerOptions) {
    this.client = options.client
    this.ghostmux = options.ghostmux
    this.log = options.log ?? (() => undefined)
    this.lingerSeconds =
      options.lingerSeconds ?? parseViewerLingerSeconds(process.env['HRC_VIEWER_LINGER_SECONDS'])
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
    this.streamStableAfterMs = options.streamStableAfterMs ?? DEFAULT_STREAM_STABLE_AFTER_MS
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearScheduled = options.clearScheduled ?? ((handle) => clearTimeout(handle))
    this.probeTmuxClients = options.probeTmuxClients ?? createTmuxClientProbe()
    this.readTaskTitles = options.readTaskTitles ?? defaultTaskTitleReader()
    this.statusProjector = new HeadlessViewerStatusProjector({
      resolveSurfaceId: (runtimeId) =>
        this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(runtimeId),
      resolveSurfaceIds: (runtimeId) => this.resolveStatusSurfaceIds(runtimeId),
      applyStatusBar: (surfaceId, spec) => this.ghostmux.setStatusBar(surfaceId, spec),
      resolveSlug: defaultTaskSlugResolver(),
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

    let failures = 0
    let everStarted = false
    try {
      while (!this.isStopped(signal)) {
        let streamStartedAt: number | undefined
        try {
          await this.client.health()
          const tail = await this.client.tailEvents({ limit: 1 })
          await this.reconcile(everStarted ? 'reconnect' : 'start')
          everStarted = true
          streamStartedAt = this.now()
          await this.consumeStream(tail, signal)
          if (!this.isStopped(signal)) {
            throw new Error('bounded event stream closed')
          }
        } catch (error) {
          if (this.isStopped(signal)) break
          // Reset the backoff only for a stream that actually ran. Resetting
          // BEFORE consumeStream (the shape this replaces) meant a stream that
          // closed immediately re-entered the catch with failures === 0, took
          // reconnectDelaysMs[0] === 0, and reconnected with no delay at all —
          // each iteration paying a full reconcile. The escalation could never
          // engage for the one case it exists to damp.
          const streamMs = streamStartedAt === undefined ? undefined : this.now() - streamStartedAt
          if (streamMs !== undefined && streamMs >= this.streamStableAfterMs) {
            failures = 0
          }
          const index = Math.min(failures, this.reconnectDelaysMs.length - 1)
          const delayMs = this.reconnectDelaysMs[index] ?? 4_000
          // Carry the backoff state on the warning: a reconnect storm is only
          // legible in the log if each line says how long the stream lasted and
          // how long the viewer is about to wait.
          this.warn('broker_headless_viewer.stream_failed', error, {
            failures,
            delayMs,
            ...(streamMs !== undefined ? { streamMs } : {}),
          })
          failures += 1
          await this.delay(delayMs, signal)
        }
      }
    } finally {
      this.stopped = true
      clearInterval(reconcileTimer)
      signal?.removeEventListener('abort', stop)
      this.statusProjector.dispose()
      for (const timer of this.reapTimers.values()) this.clearScheduled(timer)
      this.reapTimers.clear()
    }
  }

  async reconcile(reason: 'start' | 'reconnect' | 'timer' | 'stream_reset'): Promise<void> {
    if (this.reconcileInFlight !== undefined) return this.reconcileInFlight
    const operation = this.reconcileOnce(reason).finally(() => {
      if (this.reconcileInFlight === operation) this.reconcileInFlight = undefined
    })
    this.reconcileInFlight = operation
    return operation
  }

  async handleEvent(event: LifecycleEvent): Promise<void> {
    this.statusProjector.observe(event)

    if (event.eventKind === 'runtime.presentation') {
      await this.handlePresentationEvent(event)
      return
    }
    if (event.eventKind === 'session.retitled') {
      await this.handleRetitleEvent(event)
      return
    }
    if (TERMINAL_EVENT_KINDS.has(event.eventKind) && event.runtimeId !== undefined) {
      const surfaceId = await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(event.runtimeId)
      if (surfaceId !== null) {
        // The task title describes a LIVE seat. A pane lingers for minutes after
        // its runtime ends and may be recycled for another occupant, so drop the
        // title at the terminal event rather than leaving it up until the reap.
        await this.clearSecondaryBar(surfaceId)
        const occurredAt = eventTimeMs(event) ?? this.now()
        this.scheduleReap(surfaceId, event.runtimeId, event.scopeRef, occurredAt)
      }
    }
  }

  private async consumeStream(tail: HrcEventTail, signal?: AbortSignal): Promise<void> {
    const expectedIncarnation = tail.ledgerIncarnationId
    let afterSeq = tail.headHrcSeq
    for await (const record of this.client.watchBoundedEvents({
      ledgerIncarnationId: expectedIncarnation,
      afterSeq,
      ...(signal !== undefined ? { signal } : {}),
    })) {
      if (record.type === 'ledger_replaced') {
        this.log('WARN', 'broker_headless_viewer.ledger_replaced', {
          expectedLedgerIncarnationId: record.expectedLedgerIncarnationId,
          currentLedgerIncarnationId: record.currentLedgerIncarnationId,
        })
        await this.reconcile('stream_reset')
        return
      }
      if (record.ledgerIncarnationId !== expectedIncarnation) {
        throw new Error('bounded stream incarnation changed without ledger_replaced')
      }
      if (record.type === 'ready') {
        if (record.acceptedAfterHrcSeq !== afterSeq) {
          throw new Error('bounded stream admitted a different start position')
        }
        continue
      }
      if (record.type === 'gap') {
        this.log('WARN', 'broker_headless_viewer.stream_gap', {
          reason: record.reason,
          afterHrcSeq: record.afterHrcSeq,
          beforeHrcSeq: record.beforeHrcSeq,
          dropped: record.dropped,
        })
        await this.reconcile('stream_reset')
        return
      }
      afterSeq = record.event.hrcSeq
      try {
        await this.handleEvent(record.event)
      } catch (error) {
        this.warn('broker_headless_viewer.event_failed', error, {
          eventKind: record.event.eventKind,
          hrcSeq: record.event.hrcSeq,
        })
      }
    }
  }

  private async handlePresentationEvent(event: LifecycleEvent): Promise<void> {
    const payload = asRecord(event.payload)
    const invocation = asRecord(payload['invocation'])
    const presentation = asRecord(payload['presentation'])
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
    const tmux = asRecord(payload['tmux'])
    const socketPath = typeof tmux['socketPath'] === 'string' ? tmux['socketPath'] : undefined
    const attachTarget = typeof tmux['attachTarget'] === 'string' ? tmux['attachTarget'] : undefined
    if (event.runtimeId === undefined || socketPath === undefined || attachTarget === undefined) {
      this.log('INFO', 'broker_headless_viewer.skipped_no_socket', {
        runtimeId: event.runtimeId,
        scopeRef: event.scopeRef,
      })
      return
    }
    await this.ensurePane({
      runtimeId: event.runtimeId,
      hostSessionId: event.hostSessionId,
      scopeRef: event.scopeRef,
      laneRef: normalizePresentationLaneRef(event.laneRef),
      generation: event.generation,
      status: 'busy',
      presentation: {
        operatorAttachable: true,
        viewerRequested: presentation['viewerRequested'] === true,
        ...(typeof presentation['viewerWindow'] === 'string'
          ? { viewerWindow: presentation['viewerWindow'] }
          : {}),
      },
      tmux: { socketPath, attachTarget },
      ...(typeof payload['title'] === 'string' ? { title: payload['title'] } : {}),
    })
  }

  private async handleRetitleEvent(event: LifecycleEvent): Promise<void> {
    const payload = asRecord(event.payload)
    const requestedTitle = typeof payload['title'] === 'string' ? payload['title'] : undefined
    const laneRef = normalizePresentationLaneRef(event.laneRef)
    const title = requestedTitle ?? defaultHeadlessPaneTitle(event.scopeRef, laneRef)
    const row =
      event.runtimeId === undefined
        ? undefined
        : await this.currentPresentationRuntime(event.runtimeId)
    if (row !== undefined) {
      const paneSurfaceId = await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(row.runtimeId)
      await this.applyTitles(
        await this.presentationSurfaceIds(paneSurfaceId, row),
        paneSurfaceId,
        title
      )
      return
    }
    const paneKey = deriveHeadlessSessionIdentity(event.scopeRef, laneRef).paneKey
    const panes = await this.ghostmux.listHeadlessViewerPanes()
    const pane = panes.find(
      (candidate) =>
        candidate.hostSessionId === event.hostSessionId || candidate.paneKey === paneKey
    )
    if (pane !== undefined) await this.ghostmux.setHeadlessViewerTitle(pane.surfaceId, title)
  }

  private async reconcileOnce(reason: string): Promise<void> {
    try {
      const [response, latest, panes] = await Promise.all([
        this.client.listPresentationRuntimes(),
        this.client.listLatestEventBySession(),
        this.ghostmux.listHeadlessViewerPanes(),
      ])
      const rows = response.runtimes
      const rowsByRuntime = new Map(rows.map((row) => [row.runtimeId, row]))
      const rowsByPaneKey = new Map(rows.map((row) => [paneKeyFor(row), row]))
      const eventsByRuntime = latestByRuntime(latest)
      const adoptedSurfaceIds = new Set<string>()
      // One batched read for the whole fleet, BEFORE any pane is stamped, so
      // every pane in this pass is titled from the same fresh answer.
      await this.refreshTaskTitles(rows.map((row) => row.scopeRef))

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
            await this.ghostmux.rebindHeadlessViewerPane(pane.surfaceId, {
              scopeRef: row.scopeRef,
              laneRef: normalizePresentationLaneRef(row.laneRef),
              runtimeId: row.runtimeId,
              hostSessionId: row.hostSessionId,
              generation: row.generation,
              windowKey: row.presentation?.viewerWindow,
            })
          }
          await this.paintPresentationSurfaces(
            pane.surfaceId,
            row,
            eventsByRuntime.get(row.runtimeId)
          )
          continue
        }

        // No presentation row: this pane is terminal or orphaned and is headed
        // for the reaper. Same reason as the terminal-event path above.
        await this.clearSecondaryBar(pane.surfaceId)
        if (pane.runtimeId === undefined) continue
        const latestEvent = eventsByRuntime.get(pane.runtimeId)
        const terminalAt =
          latestEvent !== undefined && TERMINAL_EVENT_KINDS.has(latestEvent.eventKind)
            ? (eventTimeMs(latestEvent) ?? this.now())
            : (this.absentSince.get(pane.runtimeId) ?? this.now())
        this.absentSince.set(pane.runtimeId, terminalAt)
        this.scheduleReap(
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
          row.tmux === undefined
        ) {
          await this.paintPresentationSurfaces(undefined, row, eventsByRuntime.get(row.runtimeId))
          continue
        }
        await this.ensurePane(row, eventsByRuntime.get(row.runtimeId))
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

  private async ensurePane(
    row: PresentationRuntimeRow,
    latestEvent?: LifecycleEvent | undefined
  ): Promise<void> {
    const tmux = row.tmux
    const attachCommand = attachCommandFor(row, this.lingerSeconds)
    if (attachCommand === null || tmux === undefined) return
    // T-07711: captured by the veto below so the skip can NAME the terminals it
    // deferred to. A reclassified case has to leave a positive line — proving
    // the fix by the absence of a `created` line proves nothing.
    let operatorClients: readonly string[] = []
    const result = await this.ghostmux.ensureHeadlessViewer({
      scopeRef: row.scopeRef,
      laneRef: normalizePresentationLaneRef(row.laneRef),
      runtimeId: row.runtimeId,
      hostSessionId: row.hostSessionId,
      generation: row.generation,
      attachCommand,
      windowKey: row.presentation?.viewerWindow,
      // Only reached when no pane of ours exists for this identity, so every
      // attached client is somebody ELSE's terminal — an operator watching this
      // runtime via `hrc run`/`hrc attach`. Fails open: the probe answers `[]`
      // for every error, dead socket and timeout, and the create proceeds.
      skipCreateWhen: async () => {
        operatorClients = await this.probeTmuxClients(tmux.socketPath, tmux.attachTarget)
        return operatorClients.length > 0
      },
    })
    if (result.status === 'skipped') {
      this.log('INFO', 'broker_headless_viewer.skipped_operator_attached', {
        runtimeId: row.runtimeId,
        scopeRef: row.scopeRef,
        attachTarget: tmux.attachTarget,
        clients: operatorClients,
      })
      const current = await this.currentPresentationRuntime(row.runtimeId)
      await this.paintPresentationSurfaces(undefined, current ?? row, latestEvent)
      return
    }
    if (result.status === 'created' || result.status === 'reused') {
      const current = await this.currentPresentationRuntime(row.runtimeId)
      await this.paintPresentationSurfaces(result.surfaceId, current ?? row, latestEvent)
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

  /**
   * Read the latest store-only presentation row. A missing/newer server field
   * produces no operator targets, which is the required safe degradation.
   */
  private async currentPresentationRuntime(
    runtimeId: string
  ): Promise<PresentationRuntimeRow | undefined> {
    try {
      const response = await this.client.listPresentationRuntimes()
      return response.runtimes.find((row) => row.runtimeId === runtimeId)
    } catch (error) {
      this.warn('broker_headless_viewer.presentation_read_failed', error, { runtimeId })
      return undefined
    }
  }

  /**
   * Only an HRC-reported surface whose own controlling TTY is a current client
   * on this runtime's attach target may receive an operator presentation write.
   */
  private async qualifiedOperatorSurfaceIds(row: PresentationRuntimeRow): Promise<string[]> {
    if (row.tmux === undefined || row.operatorSurfaces === undefined) return []
    const candidates = row.operatorSurfaces.filter(
      (surface): surface is OperatorSurface =>
        typeof surface.surfaceId === 'string' &&
        surface.surfaceId.length > 0 &&
        typeof surface.clientTty === 'string' &&
        surface.clientTty.length > 0
    )
    if (candidates.length === 0) return []
    try {
      const liveClientTtys = new Set(
        await this.probeTmuxClients(row.tmux.socketPath, row.tmux.attachTarget)
      )
      return candidates
        .filter((surface) => liveClientTtys.has(surface.clientTty))
        .map((surface) => surface.surfaceId)
    } catch (error) {
      this.warn('broker_headless_viewer.operator_surface_probe_failed', error, {
        runtimeId: row.runtimeId,
      })
      return []
    }
  }

  private async presentationSurfaceIds(
    paneSurfaceId: string | null | undefined,
    row: PresentationRuntimeRow
  ): Promise<string[]> {
    return [
      ...new Set([
        ...(paneSurfaceId === null || paneSurfaceId === undefined ? [] : [paneSurfaceId]),
        ...(await this.qualifiedOperatorSurfaceIds(row)),
      ]),
    ]
  }

  /** Fresh row lookup at lifecycle flush time prevents stale operator writes. */
  private async resolveStatusSurfaceIds(runtimeId: string): Promise<readonly string[]> {
    let paneSurfaceId: string | null = null
    try {
      paneSurfaceId = await this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(runtimeId)
    } catch (error) {
      this.warn('broker_headless_viewer.status_surface_lookup_failed', error, { runtimeId })
    }
    const row = await this.currentPresentationRuntime(runtimeId)
    return row === undefined
      ? paneSurfaceId === null
        ? []
        : [paneSurfaceId]
      : await this.presentationSurfaceIds(paneSurfaceId, row)
  }

  private async applyTitles(
    surfaceIds: readonly string[],
    paneSurfaceId: string | null | undefined,
    title: string
  ): Promise<void> {
    for (const surfaceId of surfaceIds) {
      if (surfaceId === paneSurfaceId) {
        await this.ghostmux.setHeadlessViewerTitle(surfaceId, title)
      } else {
        await this.ghostmux.setTerminalTitle?.(surfaceId, title)
      }
    }
  }

  /** Paint only permitted fields over the deduplicated pane/operator target set. */
  private async paintPresentationSurfaces(
    paneSurfaceId: string | null | undefined,
    row: PresentationRuntimeRow,
    event: LifecycleEvent | undefined
  ): Promise<void> {
    const surfaceIds = await this.presentationSurfaceIds(paneSurfaceId, row)
    if (surfaceIds.length === 0) return
    await this.applyTitles(surfaceIds, paneSurfaceId, titleFor(row))
    for (const surfaceId of surfaceIds) {
      await this.ghostmux.setTerminalBackground?.(surfaceId, viewerTerminalBg(row.scopeRef))
    }
    const state =
      (event ? viewerStateForEventKind(event.eventKind) : null) ??
      viewerStateForRuntimeStatus(row.status)
    if (state !== null) {
      const slug = await defaultTaskSlugResolver()(row.scopeRef)
      const spec = renderStatusBar(
        row.scopeRef,
        state,
        slug,
        normalizePresentationLaneRef(row.laneRef)
      )
      for (const surfaceId of surfaceIds) await this.ghostmux.setStatusBar(surfaceId, spec)
    }
    const taskId = extractTaskIdFromScope(row.scopeRef)
    if (taskId !== null && !this.taskTitles.has(taskId))
      await this.refreshTaskTitles([row.scopeRef])
    for (const surfaceId of surfaceIds) await this.applySecondaryBar(surfaceId, row.scopeRef)
  }

  /**
   * Refresh last-known titles for every task carried by these scopes, in ONE
   * batched `wrkq cat`. Never throws and never evicts: an id the read could not
   * resolve keeps whatever title it already had, so a single deleted task can
   * not blank the fleet.
   */
  private async refreshTaskTitles(scopeRefs: readonly string[]): Promise<void> {
    const taskIds = new Set<string>()
    for (const scopeRef of scopeRefs) {
      const taskId = extractTaskIdFromScope(scopeRef)
      if (taskId !== null) taskIds.add(taskId)
    }
    if (taskIds.size === 0) return
    try {
      const titles = await this.readTaskTitles([...taskIds])
      for (const [taskId, title] of titles) this.taskTitles.set(taskId, title)
    } catch (error) {
      this.warn('broker_headless_viewer.task_titles_failed', error)
    }
  }

  /**
   * Stamp (or hide) the secondary bar for one pane from the last-known titles.
   * Cosmetic and total: it never throws, never delays lifecycle work, and never
   * clears a bar it merely failed to read — a task-scoped pane with no known
   * title is left exactly as it is, so a wrkq outage degrades to a stale title
   * rather than a blank one. `:primary` and lane-only seats carry no task, so
   * they are HIDDEN rather than skipped: a recycled pane would otherwise keep
   * its previous occupant's title.
   */
  private async applySecondaryBar(surfaceId: string, scopeRef: string): Promise<void> {
    try {
      const taskId = extractTaskIdFromScope(scopeRef)
      if (taskId === null) {
        await this.ghostmux.hideSecondaryStatusBar(surfaceId)
        return
      }
      const title = this.taskTitles.get(taskId)
      if (title === undefined) return
      const spec = renderSecondaryStatusBar(title)
      if (spec === null) return
      await this.ghostmux.setSecondaryStatusBar(surfaceId, spec)
    } catch (error) {
      this.warn('broker_headless_viewer.secondary_status_failed', error, { surfaceId, scopeRef })
    }
  }

  /** Drop the title bar from a pane whose seat is gone. Never throws. */
  private async clearSecondaryBar(surfaceId: string): Promise<void> {
    try {
      await this.ghostmux.hideSecondaryStatusBar(surfaceId)
    } catch (error) {
      this.warn('broker_headless_viewer.secondary_status_failed', error, { surfaceId })
    }
  }

  private scheduleReap(
    surfaceId: string,
    runtimeId: string,
    scopeRef: string,
    terminalAtMs: number
  ): void {
    if (this.reapTimers.has(runtimeId)) return
    const remainingMs = Math.max(0, terminalAtMs + this.lingerSeconds * 1_000 - this.now())
    this.log('INFO', 'headless_viewer_reap.linger_scheduled', {
      runtimeId,
      scopeRef,
      surfaceId,
      lingerSeconds: Math.ceil(remainingMs / 1_000),
    })
    const timer = this.schedule(() => {
      this.reapTimers.delete(runtimeId)
      void this.reap(surfaceId, runtimeId, scopeRef)
    }, remainingMs)
    this.reapTimers.set(runtimeId, timer)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  }

  private async reap(surfaceId: string, runtimeId: string, scopeRef: string): Promise<void> {
    try {
      const result = await this.ghostmux.reapHeadlessAgentPane(surfaceId, runtimeId)
      this.log(
        result.status === 'failed' ? 'WARN' : 'INFO',
        `headless_viewer_reap.${result.status}`,
        {
          runtimeId,
          scopeRef,
          surfaceId,
          ...(result.status === 'reaped' ? { tabCollapsed: result.tabCollapsed } : {}),
          // T-08115: a skip must say what it observed against what it required,
          // so the NEXT occurrence is self-diagnosing from the log alone.
          ...(result.status === 'skipped'
            ? {
                reason: result.reason,
                ...(result.observedRole !== undefined ? { observedRole: result.observedRole } : {}),
                ...(result.requiredRole !== undefined ? { requiredRole: result.requiredRole } : {}),
                ...(result.observedRuntimeId !== undefined
                  ? { observedRuntimeId: result.observedRuntimeId }
                  : {}),
                ...(result.requiredRuntimeId !== undefined
                  ? { requiredRuntimeId: result.requiredRuntimeId }
                  : {}),
                ...(result.probeError !== undefined ? { probeError: result.probeError } : {}),
              }
            : {}),
          ...(result.status === 'failed' ? { error: result.error } : {}),
        }
      )
    } catch (error) {
      this.warn('headless_viewer_reap.unexpected_error', error, { runtimeId, scopeRef, surfaceId })
    }
  }

  private warn(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.log('WARN', event, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted === true) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
  }

  private isStopped(signal?: AbortSignal): boolean {
    return this.stopped || signal?.aborted === true
  }
}
