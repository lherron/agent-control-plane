import { defaultHeadlessPaneTitle } from './ghostmux-identity.js'
import {
  type ViewerIdentity,
  renderSecondaryStatusBar,
  renderStatusBar,
  viewerStateForEventKind,
  viewerStateForRuntimeStatus,
  viewerTerminalBg,
} from './headless-viewer-status.js'
import type { TmuxClientProbe } from './tmux-clients.js'
import {
  type LifecycleEvent,
  type PresentationRuntimeRow,
  type ViewerGhostmux,
  type ViewerWarn,
  normalizePresentationLaneRef,
} from './viewer-contracts.js'
import {
  type TaskSlugResolver,
  type TaskTitleReader,
  extractTaskIdFromIdentity,
} from './wrkq-task-label.js'

type OperatorSurface = { surfaceId: string; clientTty: string }

function titleFor(
  row: Pick<PresentationRuntimeRow, 'scopeRef' | 'laneRef' | 'title' | 'identity'>
): string {
  return (
    row.title ??
    defaultHeadlessPaneTitle(row.scopeRef, normalizePresentationLaneRef(row.laneRef), row.identity)
  )
}

/** Paint viewer panes and operator terminals with a current HRC binding and TTY. */
export class ViewerPanePresentation {
  /**
   * Last-known wrkq title per task id (T-08331). Refreshed in one batched read
   * per reconcile and NEVER evicted on a read failure — a deleted task, a wrkq
   * missing from PATH or a hung CLI must degrade to the title already on the
   * bar, never blank every pane at once.
   */
  private readonly taskTitles = new Map<string, string>()

  constructor(
    private readonly ghostmux: ViewerGhostmux,
    private readonly probeTmuxClients: TmuxClientProbe,
    private readonly resolveTaskSlug: TaskSlugResolver,
    private readonly readTaskTitles: TaskTitleReader,
    private readonly warn: ViewerWarn
  ) {}

  /**
   * Only an HRC-reported surface whose own controlling TTY is a current client
   * on this runtime's attach target may receive an operator presentation write.
   */
  private async qualifiedOperatorSurfaceIds(row: PresentationRuntimeRow): Promise<string[]> {
    // An hrcpty supervisor reports how many clients are attached, not their
    // ttys, so no operator surface can be qualified for an hrcpty seat: only
    // the viewer's own pane is painted (T-12046).
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

  async presentationSurfaceIds(
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
  async paint(
    paneSurfaceId: string | null | undefined,
    row: PresentationRuntimeRow,
    event: LifecycleEvent | undefined
  ): Promise<void> {
    const surfaceIds = await this.presentationSurfaceIds(paneSurfaceId, row)
    if (surfaceIds.length === 0) return
    await this.applyTitles(surfaceIds, paneSurfaceId, titleFor(row))
    for (const surfaceId of surfaceIds) {
      await this.ghostmux.setTerminalBackground?.(
        surfaceId,
        viewerTerminalBg(row.identity, row.metadata)
      )
    }
    const state =
      (event ? viewerStateForEventKind(event.eventKind) : null) ??
      viewerStateForRuntimeStatus(row.status)
    if (state !== null) {
      const slug = await this.resolveTaskSlug(row.identity?.taskId)
      const spec = renderStatusBar(
        row.identity,
        state,
        slug,
        normalizePresentationLaneRef(row.laneRef),
        row.metadata
      )
      for (const surfaceId of surfaceIds) await this.ghostmux.setStatusBar(surfaceId, spec)
    }
    const taskId = extractTaskIdFromIdentity(row.identity)
    if (taskId !== null && !this.taskTitles.has(taskId))
      await this.refreshTaskTitles([row.identity])
    for (const surfaceId of surfaceIds) await this.applySecondaryBar(surfaceId, row.identity)
  }

  /**
   * Refresh titles in one batch. Missing tasks and failed reads retain the
   * last known title.
   */
  async refreshTaskTitles(identities: readonly (ViewerIdentity | undefined)[]): Promise<void> {
    const taskIds = new Set<string>()
    for (const identity of identities) {
      const taskId = extractTaskIdFromIdentity(identity)
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
   * Keep the bar as-is when a task title is unavailable. Hide it for seats
   * without a task so a recycled pane drops its previous occupant's title.
   */
  private async applySecondaryBar(
    surfaceId: string,
    identity: ViewerIdentity | undefined
  ): Promise<void> {
    try {
      const taskId = extractTaskIdFromIdentity(identity)
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
      this.warn('broker_headless_viewer.secondary_status_failed', error, { surfaceId, identity })
    }
  }

  /** Drop the title bar from a pane whose seat is gone. Never throws. */
  async clearSecondaryBar(surfaceId: string): Promise<void> {
    try {
      await this.ghostmux.hideSecondaryStatusBar(surfaceId)
    } catch (error) {
      this.warn('broker_headless_viewer.secondary_status_failed', error, { surfaceId })
    }
  }
}
