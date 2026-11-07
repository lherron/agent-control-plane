import {
  DEFAULT_GHOSTMUX_COMMAND_TIMEOUT_MS,
  GhostmuxClient,
  type GhostmuxRunner,
  type GhostmuxSurfaceState,
  isMissingSurfaceError,
  isRecord,
  parseGhostmuxSurfaceState,
} from './ghostmux-client.js'
import {
  type HeadlessSessionIdentity,
  defaultHeadlessPaneTitle,
  deriveHeadlessSessionIdentity,
  resolveWindowKey,
} from './ghostmux-identity.js'
import {
  GhostmuxPlacement,
  HEADLESS_AGENT_PANE_ROLE,
  metadataWindowKey,
} from './ghostmux-placement.js'
import {
  GhostmuxPresentation,
  type GhostmuxSecondaryStatusBarSpec,
  type GhostmuxStatusBarSpec,
  type PaintMemoOptions,
} from './ghostmux-presentation.js'
import type { ViewerIdentity } from './headless-viewer-status.js'

export type GhostmuxManagerOptions = {
  ghostmuxBin?: string | undefined
  runner?: GhostmuxRunner | undefined
  commandTimeoutMs?: number | undefined
}

export type HeadlessViewerResult =
  | { status: 'created'; surfaceId: string; tabKey: string }
  | { status: 'reused'; surfaceId: string; tabKey: string }
  /** `skipCreateWhen` vetoed a create; no surface exists and none was made. */
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

/** Live viewer-pane registry entry projected from Ghostty metadata. */
export type HeadlessViewerPane = {
  surfaceId: string
  windowId?: string | undefined
  windowKey: string
  tabKey?: string | undefined
  paneKey?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runtimeId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
}

/**
 * Why a reap declined to remove the pane (T-08115). These were all reported as
 * `not_agent_pane` before, which conflated "the pane is somebody else's, refuse"
 * with "the pane is already gone" and with "we could not ask". A reader could
 * not tell a correct refusal from a lost probe, so the skip line has to say what
 * it OBSERVED against what it REQUIRED.
 */
export type HeadlessReapSkipReason =
  /** ghostmux resolved the surface and its role is not ours — the real refusal. */
  | 'not_agent_pane'
  /** Live metadata maps the pane to a NEWER runtime — the runtime fence. */
  | 'runtime_rebound'
  /** The surface no longer exists: the pane closed before the reap timer fired. */
  | 'surface_missing'
  /** The probe itself failed (timeout, malformed answer) — nothing was observed. */
  | 'probe_failed'

/** What the reap saw on the pane, against what it required (T-08115). */
export type HeadlessReapObservation = {
  /** `hrc_role` as read, `null` when metadata existed without one. */
  observedRole?: string | null | undefined
  requiredRole?: string | undefined
  /** `hrc_runtime_id` as read, `null` when metadata existed without one. */
  observedRuntimeId?: string | null | undefined
  requiredRuntimeId?: string | undefined
  /** Raw ghostmux failure for `surface_missing` / `probe_failed`. */
  probeError?: string | undefined
}

/** Outcome of a runtime-fenced agent-pane reap (T-05237, daedalus C4). */
export type HeadlessReapResult =
  | { status: 'reaped'; surfaceId: string; tabCollapsed: boolean }
  | ({ status: 'skipped'; reason: HeadlessReapSkipReason } & HeadlessReapObservation)
  | { status: 'failed'; error: string }

function selectSplitDirection(surface: GhostmuxSurfaceState): 'right' | 'down' {
  const columns = surface.columns ?? 0
  const rows = surface.rows ?? 0
  return columns >= 100 || columns >= rows * 2 ? 'right' : 'down'
}

/**
 * Interrupt the old session-report foreground group, rather than typing a key:
 * its raw wait-key handler treats even Ctrl-C as "close" and exits the surface.
 * Ghostty's inherited UUID fences the signal to this viewer's own process.
 * A still-attached tmux client is left alone; reconciliation retries after it
 * reaches session-report, so no command can be injected into an old harness.
 */
async function interruptViewerAttachment(surfaceId: string): Promise<void> {
  const ps = Bun.spawn(['ps', '-axo', 'pid=,pgid=,command='], {
    env: { ...process.env, PRAESIDIUM_CALLER: 'hrc-viewer' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const listing = await new Response(ps.stdout).text()
  if ((await ps.exited) !== 0) throw new Error('Unable to inspect viewer attachment processes')
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const command = match[3] ?? ''
    const report = command.includes('hrc monitor session-report --runtime ')
    const attach = /(?:^|\s|\/)tmux .* attach-session /.test(command)
    if (!report && !attach) continue
    const pid = Number(match[1])
    const env = Bun.spawn(['ps', 'eww', '-p', String(pid), '-o', 'command='], {
      env: { ...process.env, PRAESIDIUM_CALLER: 'hrc-viewer' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Never log this output: ps includes the process environment.
    const details = await new Response(env.stdout).text()
    await env.exited
    if (!details.split(/\s+/).includes(`GHOSTTY_SURFACE_UUID=${surfaceId}`)) continue
    if (attach) throw new Error('Previous viewer attachment is still live; retry after detach')
    const group = Number(match[2])
    if (group <= 1 || group !== pid) throw new Error('Unexpected viewer foreground process group')
    process.kill(-group, 'SIGINT')
    // Wait until zsh has reclaimed the foreground before sending shell text.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await Bun.sleep(20)
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
    }
    throw new Error('Previous viewer session report did not exit')
  }
}

export class GhostmuxManager {
  private readonly ghostmux: GhostmuxClient
  private readonly presentation: GhostmuxPresentation
  private readonly placement: GhostmuxPlacement

  constructor(
    ghostmuxBinary = 'ghostmux',
    runner?: GhostmuxRunner | undefined,
    commandTimeoutMs = DEFAULT_GHOSTMUX_COMMAND_TIMEOUT_MS,
    private readonly interruptAttachment = interruptViewerAttachment,
    paintMemo: PaintMemoOptions = {}
  ) {
    this.ghostmux = new GhostmuxClient(ghostmuxBinary, runner, commandTimeoutMs)
    this.presentation = new GhostmuxPresentation((args) => this.ghostmux.exec(args), paintMemo)
    this.placement = new GhostmuxPlacement(this.ghostmux)
  }

  async initialize(): Promise<void> {
    await this.ghostmux.exec(['status', '--json'])
  }

  async inspectSurface(surfaceId: string): Promise<GhostmuxSurfaceState | null> {
    return this.ghostmux.inspectSurface(surfaceId)
  }

  async equalizePanes(surfaceId: string): Promise<void> {
    await this.ghostmux.equalizePanes(surfaceId)
  }

  async terminate(surfaceId: string): Promise<void> {
    this.presentation.forgetSurface(surfaceId)
    try {
      await this.ghostmux.exec(['kill-surface', '-t', surfaceId, '--force'])
    } catch (error) {
      if (error instanceof Error && isMissingSurfaceError(error.message)) return
      throw error
    }
  }

  /**
   * Best-effort: place a headless broker runtime's TUI viewer as a PANE inside the
   * single global "Headless Sessions" window — one tab per canonical `hrc_tab_key`,
   * one pane per canonical `hrc_pane_key`, the normalized `(scopeRef, laneRef)` HRC
   * session identity (T-05237, T-06321). Same-agent tester/implementer/observer
   * seats — or distinct lanes — on one task therefore get distinct panes in the same
   * task tab. Replaces the prior one-standalone-window-per-scope model that
   * proliferated windows and exhausted the pty pool. Reuse rebinds the pane's
   * `hrc_runtime_id` to the CURRENT runtime (daedalus C5) BEFORE the caller's
   * lifecycle projection can target it. Never throws: any ghostmux failure is
   * surfaced as { status: 'failed' } so the caller logs and continues headless.
   *
   * Topology authority is Ghostty metadata ONLY (daedalus invariant): titles, tab
   * labels, cwd, and focus are presentation and are never read for decisions.
   */
  async ensureHeadlessViewer(options: {
    scopeRef: string
    identity?: ViewerIdentity | undefined
    /**
     * HRC lane ref for this session (`main` or `lane:<id>`). Threaded from the
     * runtime rather than defaulted here so distinct lanes get distinct panes
     * (T-06321). Omitted/undefined normalizes to `main`.
     */
    laneRef?: string | undefined
    runtimeId: string
    hostSessionId?: string | undefined
    generation?: number | undefined
    attachCommand: string
    /** A tmux target, or (hrcpty seat, T-12046) the supervisor socket alone. */
    attachTarget?: { socketPath: string; attachTarget?: string | undefined } | undefined
    /**
     * Optional explicit pane-title override; default is `<label> · <agent>`, plus
     * ` · <role>` for a role-qualified scope.
     */
    title?: string | undefined
    /**
     * Optional initial status-bar triplet. Applied best-effort and OFF the
     * awaited critical path (fire-and-forget) so a slow/failed statusbar write
     * never delays the broker start that awaits this call (daedalus, T-04439).
     */
    statusBar?: GhostmuxStatusBarSpec | undefined
    /**
     * Optional agent-color terminal tint (`set-bg`). Identity, not state —
     * applied once on create/reuse, never per lifecycle event. Same fire-and-
     * forget discipline as the status bar.
     */
    terminalBg?: string | undefined
    /**
     * Optional window placement key (T-07118). Absent/empty ⇒ the implicit
     * default key, i.e. today's single "Headless Sessions" window.
     */
    windowKey?: string | undefined
    /**
     * Optional veto on MINTING a pane (T-07711). Consulted only on the create
     * branch — after the keyed pane lookup has missed, under the tab lock — so
     * reuse, retitle and repaint never pay for it and never consult it. The
     * caller supplies the question; today's only one is "is an operator terminal
     * already attached to this runtime's tmux target?". A predicate that answers
     * true yields `{ status: 'skipped' }` and nothing is created.
     */
    skipCreateWhen?: (() => Promise<boolean>) | undefined
  }): Promise<HeadlessViewerResult> {
    const identity = deriveHeadlessSessionIdentity(
      options.scopeRef,
      options.laneRef,
      options.identity
    )
    const tab = identity.tab
    const windowKey = resolveWindowKey(options.windowKey, tab)
    const paneTitle =
      options.title ?? defaultHeadlessPaneTitle(options.scopeRef, options.laneRef, options.identity)
    // Serialize per COMPOSITE tab key `(windowKey, tabKey)` (T-07118): concurrent
    // same-task dispatches must not both miss-then-create a duplicate tab, and two
    // differently-keyed windows must not serialize against each other. The critical
    // section re-checks live metadata AFTER acquiring the lock (daedalus concurrency
    // condition). Distinct panes within one tab still serialize under this key, which
    // is correct: the first create makes the tab, later ones split the existing pane.
    return this.placement.withHeadlessLock(`tab:${windowKey}:${tab.tabKey}`, async () => {
      try {
        const existing = await this.placement.findAgentPaneByKey(tab.tabKey, identity.paneKey)
        if (existing) {
          // Reuse: rebind the pane to the CURRENT runtime (daedalus C5) so a stale
          // terminal event for a prior runtime cannot reap this pane, then repaint.
          // Pane lookup is deliberately GLOBAL: reuse wins over placement, so a
          // newly-hinted respawn adopts the live pane wherever it already lives.
          const metadata = await this.ghostmux.getMetadata(existing.surfaceId)
          const target =
            options.attachTarget === undefined
              ? undefined
              : JSON.stringify({
                  socketPath: options.attachTarget.socketPath,
                  attachTarget: options.attachTarget.attachTarget,
                })
          const previousTarget = isRecord(metadata) ? metadata['hrc_attach_target'] : undefined
          const changed =
            previousTarget !== undefined && target !== undefined
              ? previousTarget !== target
              : isRecord(metadata) && metadata['hrc_runtime_id'] !== options.runtimeId
          if (changed) {
            await this.interruptAttachment(existing.surfaceId)
            await this.ghostmux.exec(['send-keys', '-t', existing.surfaceId, options.attachCommand])
          }
          await this.stampAgentPaneMetadata(existing.surfaceId, identity, {
            scopeRef: options.scopeRef,
            runtimeId: options.runtimeId,
            windowKey,
            hostSessionId: options.hostSessionId,
            generation: options.generation,
            attachTarget: target,
          })
          // Refresh the title on reuse too, so a reused pane always reflects the
          // current label (e.g. after a label-format change). Safe: the pane is
          // blocked in `tmux attach`, so this set-title is not clobbered.
          await this.stampPaneTitle(existing.surfaceId, paneTitle).catch(() => undefined)
          this.applyStatusBarBestEffort(existing.surfaceId, options.statusBar)
          this.applyTerminalBackgroundBestEffort(existing.surfaceId, options.terminalBg)
          return {
            status: 'reused' as const,
            surfaceId: existing.surfaceId,
            tabKey: tab.tabKey,
          }
        }

        // T-07711: the create veto goes HERE — the pane lookup above has missed
        // under the lock, so we own no pane for this identity and are about to
        // mint one. Asking before `ensureHeadlessWindow` also means a vetoed
        // create leaves no keyed window behind as a side effect.
        if (options.skipCreateWhen !== undefined && (await options.skipCreateWhen())) {
          return { status: 'skipped' as const, reason: 'create_vetoed' }
        }

        // ORDER IS MANDATORY (T-07121, daedalus #17988): find-or-create the keyed
        // window FIRST, then evaluate split-target candidates against the window it
        // returned. Reversing it re-admits the stale-key hazard the residency fence
        // exists to close.
        const target = await this.placement.ensureHeadlessWindow(windowKey)
        // An existing pane for this composite `(windowKey, tabKey)` identity is a
        // valid split target — any live pane in that tab puts the new pane in the
        // same Ghostty tab. The window fence is what keeps a console-keyed pane
        // from splitting into a same-tabKey tab in the default window; on the
        // managed path the RESIDENCY fence additionally rejects a pane that wears
        // the right key but physically lives in another window.
        const tabPane = await this.placement.findTaskTab(
          windowKey,
          tab.tabKey,
          target.kind === 'managed' ? target.windowId : undefined
        )

        // `ghostmux new`/`new-pane` transiently hit the libghostty surface_not_realize
        // race under load; ghostmux's guidance is bounded backoff (clears in 1-2 tries).
        const created = await this.ghostmux.withGhostmuxBackoff(async () =>
          parseGhostmuxSurfaceState(
            tabPane
              ? (
                  await this.ghostmux.exec([
                    'new-pane',
                    '-t',
                    tabPane.surfaceId,
                    '-d',
                    selectSplitDirection(tabPane),
                    '--json',
                  ])
                ).stdout
              : (await this.ghostmux.exec(this.placement.newTabArgs(target, paneTitle))).stdout
          )
        )
        await this.stampAgentPaneMetadata(created.surfaceId, identity, {
          scopeRef: options.scopeRef,
          runtimeId: options.runtimeId,
          windowKey,
          hostSessionId: options.hostSessionId,
          generation: options.generation,
        }).catch(() => undefined)
        // Order matters (T-05237): send the (blocking) attach command FIRST, then
        // set the title as the LAST write. The pane then stays blocked inside
        // `tmux attach` so no shell precmd/OSC-7 fires to overwrite the label.
        await this.ghostmux.withGhostmuxBackoff(() =>
          this.ghostmux.exec(['send-keys', '-t', created.surfaceId, options.attachCommand])
        )
        if (options.attachTarget !== undefined) {
          await this.ghostmux.setMetadata(
            created.surfaceId,
            {
              hrc_attach_target: JSON.stringify({
                socketPath: options.attachTarget.socketPath,
                attachTarget: options.attachTarget.attachTarget,
              }),
            },
            false
          )
        }
        await this.stampPaneTitle(created.surfaceId, paneTitle).catch(() => undefined)
        await this.equalizePanes(created.surfaceId)
        this.applyStatusBarBestEffort(created.surfaceId, options.statusBar)
        this.applyTerminalBackgroundBestEffort(created.surfaceId, options.terminalBg)
        return { status: 'created' as const, surfaceId: created.surfaceId, tabKey: tab.tabKey }
      } catch (error) {
        return {
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }

  /**
   * Runtime-bound, fenced reap of a terminating runtime's agent viewer pane
   * (T-05237, daedalus C4). Kills the surface ONLY if its live metadata still maps
   * it to `runtimeId` AND the role is `headless-agent-pane` — never by tab/agent
   * alone, so a stale terminal event cannot kill a pane already rebound to a newer
   * runtime. Never kills the window anchor. If the killed pane was the tab's last
   * live agent pane, the tab collapses with it (killing the last pane closes the
   * Ghostty tab). Best-effort: never throws.
   */
  async reapHeadlessAgentPane(surfaceId: string, runtimeId: string): Promise<HeadlessReapResult> {
    try {
      // T-08115: the probe is fallible in three different ways and only ONE of
      // them is a refusal. Swallowing all of them into `not_agent_pane` made a
      // pane that had already closed itself look like a pane we declined to
      // remove, so separate them before classifying.
      let metadata: unknown
      try {
        metadata = await this.ghostmux.getMetadata(surfaceId, false)
      } catch (error) {
        const probeError = error instanceof Error ? error.message : String(error)
        const present = await this.surfaceExists(surfaceId)
        return {
          status: 'skipped',
          // `present === undefined` means the confirming probe ALSO failed, so
          // we do not know — say `probe_failed` rather than claim it was gone.
          reason: present === false ? 'surface_missing' : 'probe_failed',
          probeError,
        }
      }
      if (!isRecord(metadata)) {
        return {
          status: 'skipped',
          reason: 'probe_failed',
          probeError: 'ghostmux answered metadata that is not an object',
        }
      }
      const observedRole = typeof metadata['hrc_role'] === 'string' ? metadata['hrc_role'] : null
      const observedRuntimeId =
        typeof metadata['hrc_runtime_id'] === 'string' ? metadata['hrc_runtime_id'] : null
      if (observedRole !== HEADLESS_AGENT_PANE_ROLE) {
        // The pane resolved and is genuinely not ours. This is the skip path
        // doing its job: never terminate a surface we do not own.
        return {
          status: 'skipped',
          reason: 'not_agent_pane',
          observedRole,
          requiredRole: HEADLESS_AGENT_PANE_ROLE,
        }
      }
      if (observedRuntimeId !== runtimeId) {
        // Rebound to a newer runtime — the fence: do NOT reap.
        return {
          status: 'skipped',
          reason: 'runtime_rebound',
          observedRuntimeId,
          requiredRuntimeId: runtimeId,
        }
      }
      const tabKey =
        typeof metadata['hrc_tab_key'] === 'string' ? metadata['hrc_tab_key'] : undefined
      const windowKey = metadataWindowKey(metadata)
      await this.terminate(surfaceId)
      // After the kill, did any sibling agent pane for this COMPOSITE tab survive?
      let tabCollapsed = false
      if (tabKey) {
        const sibling = await this.placement.findTaskTab(windowKey, tabKey).catch(() => null)
        tabCollapsed = sibling === null
      }
      return { status: 'reaped', surfaceId, tabCollapsed }
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Does Ghostty still hold this surface? The confirming probe behind the
   * `surface_missing` / `probe_failed` split (T-08115). Asks the surface list
   * rather than pattern-matching ghostmux's human-readable `can't find terminal`
   * text, which is a rendering and not a contract. Answers `undefined` when the
   * confirming probe ALSO fails — an unanswerable question, never a "gone".
   */
  private async surfaceExists(surfaceId: string): Promise<boolean | undefined> {
    try {
      const surfaces = await this.ghostmux.listSurfaces()
      const wanted = surfaceId.toLowerCase()
      return surfaces.some((surface) => surface.surfaceId.toLowerCase() === wanted)
    } catch {
      return undefined
    }
  }

  /**
   * Find the headless agent viewer pane bound to a runtime by its stamped Ghostty
   * metadata. The projector's recovery path when the durable surface_binding is
   * missing (e.g. after a DB-less restart) — DB binding is the primary cache.
   */
  async findHeadlessViewerSurfaceByRuntimeId(runtimeId: string): Promise<string | null> {
    try {
      const surfaces = await this.ghostmux.listSurfaces()
      for (const surface of surfaces) {
        const metadata = await this.ghostmux
          .getMetadata(surface.surfaceId, false)
          .catch(() => undefined)
        if (
          isRecord(metadata) &&
          metadata['hrc_role'] === HEADLESS_AGENT_PANE_ROLE &&
          metadata['hrc_runtime_id'] === runtimeId
        ) {
          return surface.surfaceId
        }
      }
    } catch {
      // best-effort
    }
    return null
  }

  /** Enumerate the metadata-owned viewer registry; presentation fields are ignored. */
  async listHeadlessViewerPanes(): Promise<HeadlessViewerPane[]> {
    const surfaces = await this.ghostmux.listSurfaces()
    const panes: HeadlessViewerPane[] = []
    for (const surface of surfaces) {
      const metadata = await this.ghostmux
        .getMetadata(surface.surfaceId, false)
        .catch(() => undefined)
      if (!isRecord(metadata) || metadata['hrc_role'] !== HEADLESS_AGENT_PANE_ROLE) continue
      panes.push({
        surfaceId: surface.surfaceId,
        ...(surface.windowId !== undefined ? { windowId: surface.windowId } : {}),
        windowKey: metadataWindowKey(metadata),
        ...(typeof metadata['hrc_tab_key'] === 'string' ? { tabKey: metadata['hrc_tab_key'] } : {}),
        ...(typeof metadata['hrc_pane_key'] === 'string'
          ? { paneKey: metadata['hrc_pane_key'] }
          : {}),
        ...(typeof metadata['hrc_scope_ref'] === 'string'
          ? { scopeRef: metadata['hrc_scope_ref'] }
          : {}),
        ...(typeof metadata['hrc_lane_ref'] === 'string'
          ? { laneRef: metadata['hrc_lane_ref'] }
          : {}),
        ...(typeof metadata['hrc_runtime_id'] === 'string'
          ? { runtimeId: metadata['hrc_runtime_id'] }
          : {}),
        ...(typeof metadata['hrc_host_session_id'] === 'string'
          ? { hostSessionId: metadata['hrc_host_session_id'] }
          : {}),
        ...(typeof metadata['hrc_generation'] === 'number'
          ? { generation: metadata['hrc_generation'] }
          : {}),
      })
    }
    return panes
  }

  /** Rebind an adopted pane to a newer runtime generation without creating anything. */
  async rebindHeadlessViewerPane(
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
  ): Promise<void> {
    const identity = deriveHeadlessSessionIdentity(
      options.scopeRef,
      options.laneRef,
      options.identity
    )
    await this.stampAgentPaneMetadata(surfaceId, identity, {
      scopeRef: options.scopeRef,
      runtimeId: options.runtimeId,
      windowKey: resolveWindowKey(options.windowKey, identity.tab),
      hostSessionId: options.hostSessionId,
      generation: options.generation,
    })
  }

  /** Retitle an adopted pane; callers compute the title from durable session facts. */
  async setHeadlessViewerTitle(surfaceId: string, title: string): Promise<void> {
    await this.presentation.setTitle(surfaceId, title)
  }

  async setTerminalTitle(surfaceId: string, title: string): Promise<void> {
    await this.presentation.setTerminalTitle(surfaceId, title)
  }

  async setStatusBar(surfaceId: string, spec: GhostmuxStatusBarSpec): Promise<void> {
    await this.presentation.setStatusBar(surfaceId, spec)
  }

  async setSecondaryStatusBar(
    surfaceId: string,
    spec: GhostmuxSecondaryStatusBarSpec
  ): Promise<void> {
    await this.presentation.setSecondaryStatusBar(surfaceId, spec)
  }

  async hideSecondaryStatusBar(surfaceId: string): Promise<void> {
    await this.presentation.hideSecondaryStatusBar(surfaceId)
  }

  async setTerminalBackground(surfaceId: string, hex: string): Promise<void> {
    await this.presentation.setTerminalBackground(surfaceId, hex)
  }

  async stampPaneTitle(surfaceId: string, title: string): Promise<void> {
    await this.presentation.stampPaneTitle(surfaceId, title)
  }

  /** Fire-and-forget status-bar write; keeps the awaited spawn path clean. */
  private applyStatusBarBestEffort(
    surfaceId: string,
    spec: GhostmuxStatusBarSpec | undefined
  ): void {
    if (!spec) return
    void this.setStatusBar(surfaceId, spec)
  }

  /** Fire-and-forget terminal-tint write; keeps the awaited spawn path clean. */
  private applyTerminalBackgroundBestEffort(surfaceId: string, hex: string | undefined): void {
    if (!hex) return
    void this.setTerminalBackground(surfaceId, hex)
  }

  /**
   * Stamp/refresh the canonical agent-pane metadata (surface-level). The uniqueness
   * authority is `hrc_pane_key` (normalized `(scopeRef, laneRef)`); `hrc_window_key`
   * + `hrc_tab_key` are the composite TAB grouping authority (T-07118); `hrc_agent_id`
   * and `hrc_role_name` are presentation/diagnosis metadata. Also records the exact
   * session identity (scope/lane/role) and the current runtime binding (T-06321).
   */
  private async stampAgentPaneMetadata(
    surfaceId: string,
    identity: HeadlessSessionIdentity,
    binding: {
      scopeRef: string
      runtimeId: string
      windowKey: string
      hostSessionId?: string | undefined
      generation?: number | undefined
      attachTarget?: string | undefined
    }
  ): Promise<void> {
    const tab = identity.tab
    await this.ghostmux.setMetadata(
      surfaceId,
      {
        hrc_role: HEADLESS_AGENT_PANE_ROLE,
        hrc_window_key: binding.windowKey,
        hrc_tab_key: tab.tabKey,
        hrc_pane_key: identity.paneKey,
        hrc_agent_id: tab.agentId,
        hrc_lane_ref: identity.laneRef,
        ...(identity.roleName ? { hrc_role_name: identity.roleName } : {}),
        ...(tab.projectId ? { hrc_project: tab.projectId } : {}),
        ...(tab.taskId ? { hrc_task_id: tab.taskId } : {}),
        hrc_scope_ref: binding.scopeRef,
        hrc_runtime_id: binding.runtimeId,
        ...(binding.attachTarget !== undefined ? { hrc_attach_target: binding.attachTarget } : {}),
        ...(binding.hostSessionId ? { hrc_host_session_id: binding.hostSessionId } : {}),
        ...(binding.generation !== undefined ? { hrc_generation: binding.generation } : {}),
      },
      false
    )
  }
}

export function createGhostmuxManager(options: GhostmuxManagerOptions = {}): GhostmuxManager {
  return new GhostmuxManager(options.ghostmuxBin, options.runner, options.commandTimeoutMs)
}
