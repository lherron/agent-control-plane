import {
  type GhostmuxClient,
  type GhostmuxSurfaceState,
  isRecord,
  isUnsupportedCommandError,
  parseGhostmuxSurfaceState,
  parseGhostmuxWindowList,
  parseGhostmuxWindowState,
  parseJson,
} from './ghostmux-client.js'
import {
  DEFAULT_HEADLESS_WINDOW_KEY,
  INTERACTIVE_WINDOW_KEY,
  headlessWindowTitle,
} from './ghostmux-identity.js'

/**
 * Consolidated headless-viewer presentation (T-05237, T-06321). Replaces the old
 * one-standalone-window-per-scope model (role `hrc-headless-viewer`): a single
 * global "Headless Sessions" window holds one tab per canonical `hrc_tab_key`,
 * and one agent pane per canonical `hrc_pane_key` — the normalized
 * `(scopeRef, laneRef)` HRC session identity, so same-agent role/lane seats on one
 * task get distinct panes (T-06321).
 *
 * INVARIANT (daedalus #10810): HRC owns this topology ONLY through Ghostty
 * metadata — never via `list-surfaces` topology, window titles, tab labels, cwd,
 * or focused state, which are presentation only.
 *
 * AMENDED (T-07118): tab identity is the COMPOSITE `(windowKey, tabKey)` pair.
 * All live panes for one canonical pair share one Ghostty tab, and a given
 * `hrc_tab_key` may appear in at most one tab PER KEYED WINDOW. Pane identity
 * (`hrc_pane_key`) stays global, so at most one live viewer pane per HRC session
 * still holds and reuse still wins over placement.
 *
 * AMENDED (T-07121): on a build that serves the first-class windows API, the
 * keyed window is a real managed window found-or-created atomically by its
 * `hrc_window_key` metadata — no anchor pane, no N+1 metadata sweep, no
 * closeable identity carrier. Placement authority splits: pane METADATA remains
 * logical identity, and the first-class `windowId` is physical RESIDENCY. That
 * does not weaken the daedalus #10810 invariant — `windowId` is API topology,
 * not presentation; titles, tab labels, cwd, and focus stay forbidden. Old
 * builds (404 on the windows API) keep the full legacy anchor path unchanged.
 */
/** Window-level metadata role stamped on the global parent window. */
const HEADLESS_SESSIONS_WINDOW_ROLE = 'headless-sessions-window'
/** Surface-level role for the non-runtime-owned anchor pane (never reaped). */
const HEADLESS_WINDOW_ANCHOR_ROLE = 'headless-window-anchor'
/** Surface-level role for a runtime-owned agent viewer pane. */
export const HEADLESS_AGENT_PANE_ROLE = 'headless-agent-pane'

/** Read the effective window key off live metadata (absent ⇒ implicit default). */
export function metadataWindowKey(metadata: unknown): string {
  if (!isRecord(metadata)) return DEFAULT_HEADLESS_WINDOW_KEY
  const raw = metadata['hrc_window_key']
  return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_HEADLESS_WINDOW_KEY
}

/**
 * The EXPLICIT window key on live metadata, or undefined when the window carries
 * none. Distinct from `metadataWindowKey`, which folds an absent key to the
 * implicit default: adoption must tell an UNTAGGED window (adoptable) apart from
 * one already tagged `default` (the headless pile, never adoptable).
 */
function explicitWindowKey(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined
  const raw = metadata['hrc_window_key']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/**
 * Where a viewer tab for a window key gets created (T-07121).
 *
 * - `managed`: a first-class window resolved by `find-or-create-by` — new tabs
 *   use `new --tab --window-id`, and `windowId` is the residency fence for
 *   split-target candidates.
 * - `anchor`: the legacy path on an old build — the window's anchor pane is the
 *   `--parent` target and there is no residency fence to apply.
 */
type HeadlessWindowTarget =
  | { kind: 'managed'; windowId: string }
  | { kind: 'anchor'; anchor: GhostmuxSurfaceState }
/**
 * A ScriptableGhostty without the first-class windows API answers 404, which
 * ghostmux renders as a distinct capability error (never `window_not_found`). An
 * older ghostmux without the `list-windows`/`--window-id` surface at all fails as
 * an unknown command. Both mean the same thing to HRC: stay on the legacy anchor
 * path (T-07121).
 */
function isWindowsApiUnsupportedError(message: string): boolean {
  return (
    message.toLowerCase().includes('does not support the windows api') ||
    isUnsupportedCommandError(message)
  )
}

function metadataIsWindowAnchor(metadata: unknown, windowKey: string): boolean {
  if (!isRecord(metadata) || metadata['hrc_role'] !== HEADLESS_WINDOW_ANCHOR_ROLE) return false
  return metadataWindowKey(metadata) === windowKey
}

/**
 * Window-FENCED tab membership (T-07118). Tab identity is the composite
 * `(windowKey, tabKey)` pair: a console-keyed pane must never find (and split
 * into) a same-tabKey pane living in the default window.
 */
function metadataIsAgentPaneForTab(metadata: unknown, windowKey: string, tabKey: string): boolean {
  if (!isRecord(metadata)) return false
  if (metadata['hrc_role'] !== HEADLESS_AGENT_PANE_ROLE) return false
  if (metadata['hrc_tab_key'] !== tabKey) return false
  return metadataWindowKey(metadata) === windowKey
}

/**
 * Pane identity stays GLOBAL (unchanged, daedalus): at most one live viewer
 * pane per HRC session, so reuse wins over placement — a hinted respawn rebinds
 * the existing pane rather than minting a second brain's window.
 */
function metadataIsAgentPaneWithKey(metadata: unknown, tabKey: string, paneKey: string): boolean {
  if (!isRecord(metadata)) return false
  if (metadata['hrc_role'] !== HEADLESS_AGENT_PANE_ROLE) return false
  if (metadata['hrc_tab_key'] !== tabKey) return false
  return metadata['hrc_pane_key'] === paneKey
}

export class GhostmuxPlacement {
  /**
   * Windows-API capability, probed at most once per daemon process (T-07121).
   * `undefined` until a DEFINITIVE answer is seen; a transient probe failure
   * (socket down, timeout) is never memoized, it just takes the legacy path for
   * that call and re-probes later.
   */
  private windowsApiSupported: boolean | undefined
  /** In-flight probe, so concurrent first dispatches issue exactly one. */
  private windowsApiProbe: Promise<boolean> | undefined
  /**
   * In-process keyed serialization for headless viewer find-or-create (T-05237,
   * daedalus concurrency condition). Two concurrent dispatches for the same tab
   * key (or the shared window) would otherwise both miss-then-create, producing a
   * duplicate tab/window. Each create path re-checks live metadata AFTER it owns
   * the lock. Sufficient for the launchd-singleton hrc-server; no cross-process
   * lock is needed because metadata is reconciled on restart.
   */
  private readonly headlessLocks = new Map<string, Promise<void>>()

  constructor(private readonly ghostmux: GhostmuxClient) {}

  /**
   * Serialize an async critical section by key (T-05237). Tasks for the same key
   * run strictly in submission order; distinct keys run concurrently. The chain
   * never rejects (errors are isolated to each task's own returned promise), so a
   * failed find-or-create cannot wedge later calls for the same key.
   */
  withHeadlessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.headlessLocks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.headlessLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  /** Argv for a fresh viewer tab in the keyed window (T-07121). */
  newTabArgs(target: HeadlessWindowTarget, paneTitle: string): string[] {
    const placement =
      target.kind === 'managed'
        ? ['--window-id', target.windowId]
        : ['--parent', target.anchor.surfaceId]
    return ['new', '--tab', ...placement, '--title', paneTitle, '--json']
  }

  /**
   * Whether this ScriptableGhostty serves the first-class windows API (T-07121).
   * Probed at most once per daemon process with the cheapest read on the surface
   * (`list-windows`); a 404 / unknown-command answer memoizes the capability OFF
   * and every keyed-window call stays on the legacy anchor path forever after.
   */
  private async supportsWindowsApi(): Promise<boolean> {
    if (this.windowsApiSupported !== undefined) return this.windowsApiSupported
    this.windowsApiProbe ??= this.probeWindowsApi()
    const supported = await this.windowsApiProbe
    // A transient failure left the capability undecided — drop the memoized probe
    // so the next dispatch asks again rather than being pinned to legacy.
    if (this.windowsApiSupported === undefined) this.windowsApiProbe = undefined
    return supported
  }

  private async probeWindowsApi(): Promise<boolean> {
    try {
      await this.ghostmux.exec(['list-windows', '--json'])
      this.windowsApiSupported = true
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isWindowsApiUnsupportedError(message)) {
        this.windowsApiSupported = false
        return false
      }
      return false
    }
  }

  /**
   * Resolve the keyed window to place viewer tabs in.
   *
   * On a windows-API build this is ONE atomic call: `new --window
   * --find-or-create-by '{"hrc_window_key": <key>}'`. A hit returns the oldest
   * matching window with its metadata untouched; a miss creates one carrying the
   * key. Because the server is the arbiter, no HRC-side window lock is needed —
   * concurrent dispatches for different tab keys in one window converge on the
   * same window id. Legacy builds keep the locked anchor find-or-create.
   */
  async ensureHeadlessWindow(windowKey: string): Promise<HeadlessWindowTarget> {
    if (await this.supportsWindowsApi()) {
      try {
        // T-07603: only the INTERACTIVE window is adopted from what the operator
        // already has open, so it needs a find-only pass before find-or-CREATE.
        // T-07930: chief and every other named key are managed windows, just like
        // the default pile, and must never stamp an untagged operator window.
        if (windowKey === INTERACTIVE_WINDOW_KEY) {
          const adopted = await this.adoptInteractiveWindow(windowKey)
          if (adopted !== undefined) return { kind: 'managed', windowId: adopted }
        }
        const window = await this.ghostmux.withGhostmuxBackoff(async () =>
          parseGhostmuxWindowState(
            (
              await this.ghostmux.exec([
                'new',
                '--window',
                '--find-or-create-by',
                JSON.stringify({ hrc_window_key: windowKey }),
                '--metadata',
                JSON.stringify({
                  hrc_role: HEADLESS_SESSIONS_WINDOW_ROLE,
                  hrc_window_key: windowKey,
                }),
                '--title',
                headlessWindowTitle(windowKey),
                '--json',
              ])
            ).stdout
          )
        )
        return { kind: 'managed', windowId: window.windowId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // The build changed under a live daemon (Ghostty downgraded/restarted old).
        // Re-memoize OFF and fall through to legacy rather than failing the viewer.
        if (!isWindowsApiUnsupportedError(message)) throw error
        this.windowsApiSupported = false
      }
    }
    return { kind: 'anchor', anchor: await this.ensureLegacyWindowAnchor(windowKey) }
  }

  /**
   * Resolve the operator's interactive window WITHOUT an operator metadata stamp
   * (T-07603).
   *
   * 1. A window already tagged with this key wins, found by a server-side `--meta`
   *    filter — the steady state after the first adoption, one cheap read.
   * 2. Otherwise adopt the OLDEST untagged window and stamp it, so every later
   *    lookup is an ordinary tagged hit.
   * 3. No untagged window at all ⇒ undefined, and the caller creates one.
   *
   * There is deliberately no "skip windows whose surfaces are all HRC-owned"
   * guard. The headless window is stamped atomically at creation by
   * `find-or-create-by`, so it is never untagged and step 2 cannot select it; and
   * a Ghostty restart that wipes tags also destroys every surface, so no
   * untagged-window-with-stale-panes case exists. Such a guard would protect
   * nothing reachable while rejecting the operator's real working window whenever
   * it happened to hold only agent panes — reproducing the exact defect this
   * change fixes.
   *
   * Serialized on the `window:<key>` lock so two concurrent first-placements
   * cannot adopt two different windows. Any failure degrades to undefined, i.e.
   * to the pre-T-07603 behavior of creating a fresh keyed window.
   */
  private adoptInteractiveWindow(windowKey: string): Promise<string | undefined> {
    return this.withHeadlessLock(`window:${windowKey}`, async () => {
      try {
        // Steady state — the window was adopted on an earlier placement and wears
        // the key. One server-side filtered read, no client scan.
        const tagged = parseGhostmuxWindowList(
          (
            await this.ghostmux.exec([
              'list-windows',
              '--meta',
              `hrc_window_key=${windowKey}`,
              '--json',
            ])
          ).stdout
        )
        const hit = tagged[0]
        if (hit !== undefined) return hit.windowId

        // First interactive placement of this Ghostty lifetime: scan and adopt.
        const windows = parseGhostmuxWindowList(
          (await this.ghostmux.exec(['list-windows', '--json'])).stdout
        )
        const untagged = windows.find((window) => explicitWindowKey(window.metadata) === undefined)
        if (untagged === undefined) return undefined

        await this.setWindowMetadata(untagged.windowId, {
          hrc_role: HEADLESS_SESSIONS_WINDOW_ROLE,
          hrc_window_key: windowKey,
        })
        return untagged.windowId
      } catch {
        return undefined
      }
    })
  }

  /** Write first-class managed-window metadata by window id (T-07121 surface). */
  private async setWindowMetadata(
    windowId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.ghostmux.exec([
      'metadata',
      'set',
      '--window-id',
      windowId,
      JSON.stringify(metadata),
      '--json',
    ])
  }

  /**
   * LEGACY (pre-windows-API builds only): find-or-create the keyed "Headless
   * Sessions" window by its anchor surface — the stable `--parent` target for new
   * task tabs. The anchor is non-runtime-owned and is never reaped. Serialized on
   * a shared window lock so two concurrent first-dispatches cannot create two
   * windows; the managed path needs no such lock because find-or-create is atomic.
   */
  private ensureLegacyWindowAnchor(windowKey: string): Promise<GhostmuxSurfaceState> {
    return this.withHeadlessLock(`window:${windowKey}`, async () => {
      const existing = await this.findWindowAnchor(windowKey)
      if (existing) return existing
      const created = await this.ghostmux.withGhostmuxBackoff(async () =>
        this.resolveCreatedWindowAnchor(
          (
            await this.ghostmux.exec([
              'new',
              '--window',
              '--title',
              headlessWindowTitle(windowKey),
              '--json',
            ])
          ).stdout
        )
      )
      // Surface-level role identifies the anchor pane; window-level role marks the
      // whole window. Both carry the window key so a later find-or-create resolves
      // the SAME keyed window (T-07118). Both best-effort.
      await this.ghostmux
        .setMetadata(
          created.surfaceId,
          { hrc_role: HEADLESS_WINDOW_ANCHOR_ROLE, hrc_window_key: windowKey },
          false
        )
        .catch(() => undefined)
      await this.ghostmux
        .setMetadata(
          created.surfaceId,
          { hrc_role: HEADLESS_SESSIONS_WINDOW_ROLE, hrc_window_key: windowKey },
          true
        )
        .catch(() => undefined)
      return created
    })
  }

  /**
   * Resolve the anchor SURFACE of a just-created window.
   *
   * `ghostmux new --window --json` answers with a WINDOW object, not a surface:
   * its `id` is a window id and the real anchor surface is `terminal_ids[0]`.
   * (`new --tab` and `new-pane` both answer with surfaces — this shape is unique
   * to `--window`.) Feeding that window id back as a `-t`/`--parent` target fails
   * with "Terminal not found", so every viewer placed into a freshly created
   * window silently failed. Latent before T-07118 because the one global window
   * effectively always pre-existed; routine now that any new window key must
   * create its window. Caught by the live smoke, not by any unit test.
   *
   * Falls back to the old surface-shaped parse so an older ghostmux that really
   * does answer with a surface keeps working.
   */
  private async resolveCreatedWindowAnchor(stdout: string): Promise<GhostmuxSurfaceState> {
    const parsed = parseJson(stdout)
    const record = isRecord(parsed) ? parsed : {}
    const terminalIds = record['terminal_ids']
    const anchorId =
      Array.isArray(terminalIds) && typeof terminalIds[0] === 'string' && terminalIds[0].length > 0
        ? terminalIds[0]
        : parseGhostmuxSurfaceState(stdout).surfaceId
    // Re-read the live surface so split-direction sizing sees real dimensions.
    const live = await this.ghostmux.inspectSurface(anchorId).catch(() => null)
    return live ?? { kind: 'ghostty', surfaceId: anchorId, createdBy: 'ghostmux' }
  }

  private async findWindowAnchor(windowKey: string): Promise<GhostmuxSurfaceState | null> {
    const surfaces = await this.ghostmux.listSurfaces()
    for (const surface of surfaces) {
      const metadata = await this.ghostmux
        .getMetadata(surface.surfaceId, false)
        .catch(() => undefined)
      if (metadataIsWindowAnchor(metadata, windowKey)) return surface
    }
    return null
  }

  /**
   * Any live agent pane sharing this COMPOSITE `(windowKey, tabKey)` identity — a
   * valid split target for that tab in that window (T-07118).
   *
   * RESIDENCY FENCE (T-07121, daedalus #17988): when `residentWindowId` is given
   * (the managed window find-or-create just returned), a candidate must ALSO
   * physically live in that window. After an upstream managed+managed hand-merge
   * the losing registry entry dissolves but its PANES survive inside the winner
   * still wearing the old `hrc_window_key`; metadata alone would send the next
   * hinted session splitting into that stale tab in the wrong window while the
   * freshly created keyed window sat empty. Residency is read from the
   * first-class `window_id`, never cached — a dragged tab changes it. A candidate
   * whose residency cannot be read fails the fence, and the stale metadata is
   * left in place: it is inert, because pane reuse is keyed on `hrc_pane_key`.
   */
  async findTaskTab(
    windowKey: string,
    tabKey: string,
    residentWindowId?: string | undefined
  ): Promise<GhostmuxSurfaceState | null> {
    const surfaces = await this.ghostmux.listSurfaces()
    for (const surface of surfaces) {
      if (residentWindowId !== undefined && surface.windowId !== residentWindowId) continue
      const metadata = await this.ghostmux
        .getMetadata(surface.surfaceId, false)
        .catch(() => undefined)
      if (metadataIsAgentPaneForTab(metadata, windowKey, tabKey)) return surface
    }
    return null
  }

  /** The live agent pane for `(tabKey, paneKey)`, if one exists (T-06321). */
  async findAgentPaneByKey(tabKey: string, paneKey: string): Promise<GhostmuxSurfaceState | null> {
    const surfaces = await this.ghostmux.listSurfaces()
    for (const surface of surfaces) {
      const metadata = await this.ghostmux
        .getMetadata(surface.surfaceId, false)
        .catch(() => undefined)
      if (metadataIsAgentPaneWithKey(metadata, tabKey, paneKey)) return surface
    }
    return null
  }
}
