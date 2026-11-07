import { type GhostmuxRunner, isUnsupportedCommandError } from './ghostmux-client.js'

/**
 * How long an applied title/bg/status-bar value suppresses an identical rewrite
 * (T-10484). Every ghostmux exec costs a full terminal list inside Ghostty, and
 * reconcile repaints every pane; the TTL keeps periodic drift repair (a program
 * can overwrite a title or background with its own OSC) without repainting the
 * fleet on every stream reset.
 */
export const DEFAULT_PAINT_MEMO_TTL_MS = 10 * 60 * 1_000

export type PaintMemoOptions = {
  ttlMs?: number | undefined
  now?: (() => number) | undefined
}

type PaintSlot = 'title' | 'bg' | 'statusbar' | 'secondary'
/**
 * Full Ghostty status-bar triplet. ghostmux `statusbar set` sets all three text
 * fields at once, so callers always supply the whole bar (T-04439).
 */
export type GhostmuxStatusBarSpec = {
  left: string
  center: string
  right: string
  fg?: string | undefined
  bg?: string | undefined
}

/**
 * The Ghostty SECONDARY status-bar slot — the title bar that renders under the
 * primary triplet (T-08331). No colours: hcs writes this slot uncoloured today
 * and the two writers must overlap byte-identically until hcs stops (T-08332).
 */
export type GhostmuxSecondaryStatusBarSpec = {
  left: string
  center: string
  right: string
}

/** Status-bar fields are `|`-delimited on the wire; keep them single-line and `|`-free. */
function sanitizeStatusField(value: string): string {
  return value.replace(/[|\r\n]+/g, ' ').trim()
}

/**
 * Secondary-slot field sanitizing, byte-identical to hcs's `statusBarField`
 * (`internal/ghost/client.go`): `|` becomes `/` — NOT a space, as the primary
 * rule does — and each of `\n` `\r` `\t` becomes one space, then trim. The two
 * writers stamp this slot simultaneously until T-08332 removes hcs's, so any
 * divergence here shows up as a bar flapping between two renderings at two
 * cadences.
 */
function sanitizeSecondaryStatusField(value: string): string {
  return value
    .replace(/\|/g, '/')
    .replace(/[\n\r\t]/g, ' ')
    .trim()
}

export class GhostmuxPresentation {
  /** Set once a recognizable "statusbar unsupported" error is seen (T-04439). */
  private statusBarUnsupported = false
  /** Separate memo: set once `set-bg` is seen to be unsupported (T-04439). */
  private setBgUnsupported = false
  /**
   * THIRD, separate memo: set once the SECONDARY slot is seen to be unsupported
   * (T-08331). An older Ghostty that accepts a primary write and refuses
   * `--bar secondary` must not switch the primary bar off as collateral.
   */
  private secondaryStatusBarUnsupported = false
  /** Last successfully applied presentation value per surface and slot (T-10484). */
  private readonly paintMemo = new Map<string, Map<PaintSlot, { value: string; at: number }>>()
  private readonly paintMemoTtlMs: number
  private readonly now: () => number

  constructor(
    private readonly exec: GhostmuxRunner,
    paintMemo: PaintMemoOptions = {}
  ) {
    this.paintMemoTtlMs = paintMemo.ttlMs ?? DEFAULT_PAINT_MEMO_TTL_MS
    this.now = paintMemo.now ?? Date.now
  }

  forgetSurface(surfaceId: string): void {
    this.paintMemo.delete(surfaceId)
  }

  /** Presentation-only title write for an operator-owned terminal. */
  async setTerminalTitle(surfaceId: string, title: string): Promise<void> {
    await this.setTitle(surfaceId, title)
  }

  /**
   * Apply a full status-bar triplet. Public primitive — all status-bar writes
   * go through here. Single attempt (NO multi-second backoff), swallows every
   * failure, and memoizes an unsupported-statusbar capability OFF so old Ghostty
   * stops generating background load (daedalus, T-04439).
   */
  async setStatusBar(surfaceId: string, spec: GhostmuxStatusBarSpec): Promise<void> {
    if (this.statusBarUnsupported) return
    const text = [spec.left, spec.center, spec.right].map(sanitizeStatusField).join('|')
    const args = ['statusbar', 'set', '-t', surfaceId, text]
    if (spec.fg) args.push('--fg', spec.fg)
    if (spec.bg) args.push('--bg', spec.bg)
    try {
      await this.paintOnce(surfaceId, 'statusbar', args.slice(4).join('\0'), async () => {
        await this.exec(args)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnsupportedCommandError(message)) this.statusBarUnsupported = true
      // Cosmetic — never propagate.
    }
  }

  /**
   * Write the SECONDARY slot and make it visible (T-08331).
   *
   * `set` alone renders NOTHING — the secondary slot defaults to hidden — so
   * `show` is part of the operation, not an optional follow-up. Single attempt,
   * swallows every failure, and memoizes an unsupported secondary slot in its
   * OWN flag: ghostmux refuses rather than falling back to the primary bar, so
   * an `unsupported` answer is a capability fact, not a retryable failure.
   */
  async setSecondaryStatusBar(
    surfaceId: string,
    spec: GhostmuxSecondaryStatusBarSpec
  ): Promise<void> {
    if (this.secondaryStatusBarUnsupported) return
    const text = [spec.left, spec.center, spec.right].map(sanitizeSecondaryStatusField).join('|')
    try {
      await this.paintOnce(surfaceId, 'secondary', `set:${text}`, async () => {
        await this.exec(['statusbar', 'set', '-t', surfaceId, '--bar', 'secondary', text])
        await this.exec(['statusbar', 'show', '-t', surfaceId, '--bar', 'secondary'])
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnsupportedCommandError(message)) this.secondaryStatusBarUnsupported = true
      // Cosmetic — never propagate.
    }
  }

  /**
   * Hide the SECONDARY slot, so a pane with no task — and a recycled pane whose
   * previous occupant had one — never carries a stale title (T-08331).
   */
  async hideSecondaryStatusBar(surfaceId: string): Promise<void> {
    if (this.secondaryStatusBarUnsupported) return
    try {
      await this.paintOnce(surfaceId, 'secondary', 'hidden', async () => {
        await this.exec(['statusbar', 'hide', '-t', surfaceId, '--bar', 'secondary'])
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnsupportedCommandError(message)) this.secondaryStatusBarUnsupported = true
      // Cosmetic — never propagate.
    }
  }

  /**
   * Set the terminal default background (OSC 11 via `set-bg`) — the agent-color
   * identity channel for headless viewer surfaces, since this Ghostty ignores
   * statusbar bg. Public primitive: single attempt, swallows every failure,
   * memoizes an unsupported `set-bg` capability SEPARATELY from statusbar
   * (daedalus, T-04439).
   */
  async setTerminalBackground(surfaceId: string, hex: string): Promise<void> {
    if (this.setBgUnsupported) return
    try {
      await this.paintOnce(surfaceId, 'bg', hex, async () => {
        await this.exec(['set-bg', '-t', surfaceId, hex, '--json'])
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnsupportedCommandError(message)) this.setBgUnsupported = true
      // Cosmetic — never propagate.
    }
  }

  /** Memoized title write shared by viewer and operator presentation. */
  async setTitle(surfaceId: string, title: string): Promise<void> {
    await this.paintOnce(surfaceId, 'title', title, async () => {
      await this.exec(['set-title', '-t', surfaceId, title])
    })
  }

  /**
   * Unconditional pane title write for create/rebind, recorded in the paint memo
   * so a later presentation title is compared against what the pane really shows.
   */
  async stampPaneTitle(surfaceId: string, title: string): Promise<void> {
    this.forgetPaint(surfaceId, 'title')
    await this.setTitle(surfaceId, title)
  }

  /**
   * Run a presentation write unless the same value was applied to this slot
   * within the TTL (T-10484). The slot is forgotten before the write and only
   * recorded after it succeeds, so a failed or interrupted write is retried.
   */
  private async paintOnce(
    surfaceId: string,
    slot: PaintSlot,
    value: string,
    write: () => Promise<void>
  ): Promise<void> {
    const prior = this.paintMemo.get(surfaceId)?.get(slot)
    if (prior !== undefined && prior.value === value && this.now() - prior.at < this.paintMemoTtlMs)
      return
    this.forgetPaint(surfaceId, slot)
    await write()
    let slots = this.paintMemo.get(surfaceId)
    if (slots === undefined) {
      slots = new Map()
      this.paintMemo.set(surfaceId, slots)
    }
    slots.set(slot, { value, at: this.now() })
  }

  private forgetPaint(surfaceId: string, slot: PaintSlot): void {
    const slots = this.paintMemo.get(surfaceId)
    if (slots === undefined) return
    slots.delete(slot)
    if (slots.size === 0) this.paintMemo.delete(surfaceId)
  }
}
