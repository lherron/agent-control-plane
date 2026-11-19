import type { HrcClient, HrcEventTail } from 'hrc-sdk'

import type {
  GhostmuxSecondaryStatusBarSpec,
  GhostmuxStatusBarSpec,
} from './ghostmux-presentation.js'
import type { HeadlessReapResult, HeadlessViewerPane, HeadlessViewerResult } from './ghostmux.js'
import type { ViewerIdentity } from './headless-viewer-status.js'
import type { HrcptyClientProbe } from './hrcpty-clients.js'
import type { TmuxClientProbe } from './tmux-clients.js'
import type { TaskSlugResolver, TaskTitleReader } from './wrkq-task-label.js'

export type HrcViewerClient = Pick<
  HrcClient,
  | 'health'
  | 'tailEvents'
  | 'watchBoundedEvents'
  | 'listLatestEventBySession'
  | 'listPresentationRuntimes'
>

export type LifecycleEvent = HrcEventTail['events'][number]
/**
 * An hrcpty seat's presentation (T-12046): rusthrc projects it beside `tmux` on
 * the presentation row and on the `runtime.presentation` event. The viewer needs
 * only the attach pair; the event payload carries no `supervisorPid`, so the
 * row's stricter SDK type is replaced, and the value is read defensively.
 */
export type HrcptyPresentation = { socketPath: string; attachCommand: string }

type HrcPresentationRuntimeRow = Awaited<
  ReturnType<HrcViewerClient['listPresentationRuntimes']>
>['runtimes'][number]
export type PresentationRuntimeRow = Omit<HrcPresentationRuntimeRow, 'hrcpty'> & {
  hrcpty?: HrcptyPresentation | undefined
}
export type ViewerGhostmux = {
  ensureHeadlessViewer(options: {
    scopeRef: string
    identity?: ViewerIdentity | undefined
    laneRef?: string | undefined
    runtimeId: string
    hostSessionId?: string | undefined
    generation?: number | undefined
    attachCommand: string
    attachTarget?: { socketPath: string; attachTarget?: string | undefined } | undefined
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
      identity?: ViewerIdentity | undefined
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

export type ViewerWarn = (event: string, error: unknown, fields?: Record<string, unknown>) => void

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
  /** Attached client count for an hrcpty seat (T-12046). Injected for tests. */
  probeHrcptyClients?: HrcptyClientProbe | undefined
  /** Batched wrkq task-title reader for the secondary bar (T-08331). Injected for tests. */
  readTaskTitles?: TaskTitleReader | undefined
  /** wrkq task-slug resolver for the primary status bar. Injected for tests. */
  resolveTaskSlug?: TaskSlugResolver | undefined
  /** Overrides `MANAGE_NON_TASK_SESSIONS`. Injected for tests. */
  manageNonTaskSessions?: boolean | undefined
}

export function normalizePresentationLaneRef(laneRef: string | undefined): string {
  return laneRef ?? 'main'
}
