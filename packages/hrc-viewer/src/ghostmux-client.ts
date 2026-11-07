export type GhostmuxExecResult = {
  stdout: string
  stderr: string
}

export type GhostmuxRunner = (args: string[]) => Promise<GhostmuxExecResult>

export const DEFAULT_GHOSTMUX_COMMAND_TIMEOUT_MS = 5_000

export class GhostmuxCommandTimeoutError extends Error {
  override readonly name = 'GhostmuxCommandTimeoutError'
  readonly code = 'ghostmux_command_timeout'

  constructor(
    readonly args: readonly string[],
    readonly timeoutMs: number
  ) {
    super(`ghostmux ${args.join(' ')} timed out after ${timeoutMs}ms`)
  }
}

export type GhostmuxSurfaceState = {
  kind: 'ghostty'
  surfaceId: string
  shortId?: string | undefined
  name?: string | undefined
  title?: string | undefined
  cwd?: string | undefined
  focused?: boolean | undefined
  rows?: number | undefined
  columns?: number | undefined
  anchorSurfaceId?: string | undefined
  /**
   * First-class managed-window id this surface CURRENTLY resides in (T-07121).
   * Live property, never cacheable: a tab dragged between windows changes it.
   * Absent on builds without the windows API.
   */
  windowId?: string | undefined
  createdBy: 'ghostmux'
}

/** A first-class managed window as answered by `new --window` / `list-windows`. */
export type GhostmuxWindowState = {
  windowId: string
  /** `false` when `--find-or-create-by` matched an existing window (T-07121). */
  created: boolean
  terminalIds: string[]
}

/** One managed window as answered by `list-windows` (T-07603 adoption scan). */
export type GhostmuxManagedWindow = {
  windowId: string
  metadata: Record<string, unknown>
}

/**
 * An old Ghostty / ghostmux without a given subcommand fails with a recognizable
 * capability error rather than a transient surface error. We memo that off for
 * the process so we stop generating background load. Callers keep SEPARATE memo
 * flags per command — a statusbar no-op is not a set-bg failure and vice versa.
 */
export function isUnsupportedCommandError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('unknown command') ||
    normalized.includes('unknown subcommand') ||
    normalized.includes('unrecognized') ||
    normalized.includes('not implemented') ||
    normalized.includes('unsupported') ||
    normalized.includes('no such command') ||
    normalized.includes('404')
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function getNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function getBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key]
  return typeof candidate === 'boolean' ? candidate : undefined
}

export function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return {}
  return JSON.parse(trimmed) as unknown
}

export function parseGhostmuxSurfaceState(stdout: string): GhostmuxSurfaceState {
  const parsed = parseJson(stdout)
  const record = isRecord(parsed) ? parsed : {}
  const nested =
    (isRecord(record['terminal']) && record['terminal']) ||
    (isRecord(record['surface']) && record['surface']) ||
    (isRecord(record['pane']) && record['pane']) ||
    record
  const surfaceId = getString(nested, 'id', 'surface_id', 'surfaceId', 'uuid')
  if (!surfaceId) {
    throw new Error(`ghostmux command did not return a surface id: ${stdout.trim() || '<empty>'}`)
  }

  return {
    kind: 'ghostty',
    surfaceId,
    shortId: getString(nested, 'short_id', 'shortId'),
    name: getString(nested, 'name'),
    title: getString(nested, 'title'),
    cwd: getString(nested, 'working_directory', 'cwd'),
    focused: getBoolean(nested, 'focused'),
    rows: getNumber(nested, 'rows'),
    columns: getNumber(nested, 'columns'),
    windowId: getString(nested, 'window_id', 'windowId'),
    createdBy: 'ghostmux',
  }
}

/**
 * Parse the WINDOW object answered by `ghostmux new --window [--find-or-create-by]`
 * (T-07121). `id` is a window id — NOT a surface id — and `created` reports
 * whether find-or-create missed. Feeding the window id to a `-t`/`--parent`
 * surface target fails with "Terminal not found"; it is only ever a `--window-id`.
 */
export function parseGhostmuxWindowState(stdout: string): GhostmuxWindowState {
  const parsed = parseJson(stdout)
  const record = isRecord(parsed) ? parsed : {}
  const windowId = getString(record, 'id', 'window_id', 'windowId')
  if (!windowId) {
    throw new Error(`ghostmux command did not return a window id: ${stdout.trim() || '<empty>'}`)
  }
  const terminalIds = Array.isArray(record['terminal_ids'])
    ? record['terminal_ids'].filter((id): id is string => typeof id === 'string')
    : []
  return {
    windowId,
    created: record['created'] === true,
    terminalIds,
  }
}

/**
 * Parse `ghostmux list-windows --json` (T-07603 adoption scan).
 *
 * Order is PRESERVED. The server answers in creation order, so the first match
 * is the oldest — the only tiebreak adoption uses. `list-windows` exposes no
 * timestamp, so this ordering is the sole age signal; accepted as best-effort
 * (Lance, 2026-08-27), bounded because a wrong pick lasts one Ghostty lifetime.
 */
export function parseGhostmuxWindowList(stdout: string): GhostmuxManagedWindow[] {
  const parsed = parseJson(stdout)
  const windows = isRecord(parsed) && Array.isArray(parsed['windows']) ? parsed['windows'] : []
  return windows.filter(isRecord).flatMap((window) => {
    const windowId = getString(window, 'id', 'window_id', 'windowId')
    if (!windowId) return []
    const metadata = window['metadata']
    return [{ windowId, metadata: isRecord(metadata) ? metadata : {} }]
  })
}

function parseGhostmuxSurfaceList(stdout: string): GhostmuxSurfaceState[] {
  const parsed = parseJson(stdout)
  const terminals =
    isRecord(parsed) && Array.isArray(parsed['terminals'])
      ? parsed['terminals']
      : isRecord(parsed) && Array.isArray(parsed['surfaces'])
        ? parsed['surfaces']
        : Array.isArray(parsed)
          ? parsed
          : []
  return terminals
    .filter(isRecord)
    .map((terminal) => parseGhostmuxSurfaceState(JSON.stringify(terminal)))
}

function unwrapGhostmuxMetadata(value: unknown): unknown {
  if (!isRecord(value)) return value
  return isRecord(value['data']) ? value['data'] : value
}

export function isMissingSurfaceError(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('not found') ||
    normalized.includes('no such') ||
    normalized.includes('unknown target') ||
    normalized.includes('missing target')
  )
}

export class GhostmuxClient {
  private readonly commandTimeoutMs: number

  constructor(
    private readonly ghostmuxBinary = 'ghostmux',
    private readonly runner?: GhostmuxRunner | undefined,
    commandTimeoutMs = DEFAULT_GHOSTMUX_COMMAND_TIMEOUT_MS
  ) {
    this.commandTimeoutMs = Math.max(1, Math.trunc(commandTimeoutMs))
  }

  async inspectSurface(surfaceId: string): Promise<GhostmuxSurfaceState | null> {
    try {
      const surfaces = parseGhostmuxSurfaceList(
        (await this.exec(['list-surfaces', '--json'])).stdout
      )
      return surfaces.find((surface) => surface.surfaceId === surfaceId) ?? null
    } catch (error) {
      if (error instanceof Error && isMissingSurfaceError(error.message)) return null
      throw error
    }
  }

  async equalizePanes(surfaceId: string): Promise<void> {
    try {
      await this.exec(['equalize-panes', '-t', surfaceId])
    } catch (error) {
      if (error instanceof Error && isMissingSurfaceError(error.message)) return
      throw error
    }
  }

  async listSurfaces(): Promise<GhostmuxSurfaceState[]> {
    return parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
  }

  // libghostty surface creation/realization races transiently under load; ghostmux
  // itself recommends retrying with the 0.5/1/2/4s backoff schedule before giving up.
  async withGhostmuxBackoff<T>(operation: () => Promise<T>): Promise<T> {
    const delaysMs = [0, 500, 1000, 2000, 4000]
    let lastError: unknown
    for (const delayMs of delaysMs) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      try {
        return await operation()
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('ghostmux operation failed')
  }

  async getMetadata(surfaceId: string, window = false): Promise<unknown> {
    return unwrapGhostmuxMetadata(
      parseJson(
        (
          await this.exec([
            'metadata',
            'get',
            '-t',
            surfaceId,
            ...(window ? ['--window'] : []),
            '--json',
          ])
        ).stdout
      )
    )
  }

  async setMetadata(
    surfaceId: string,
    metadata: Record<string, unknown>,
    window = false
  ): Promise<void> {
    await this.exec([
      'metadata',
      'set',
      '-t',
      surfaceId,
      JSON.stringify(metadata),
      ...(window ? ['--window'] : []),
      '--json',
    ])
  }

  async exec(args: string[]): Promise<GhostmuxExecResult> {
    if (this.runner) {
      return await this.withCommandTimeout(args, this.runner(args))
    }

    const proc = Bun.spawn([this.ghostmuxBinary, ...args], {
      env: { ...process.env, PRAESIDIUM_CALLER: 'hrc-viewer' },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = new Response(proc.stdout).text()
    const stderr = new Response(proc.stderr).text()
    const exitCode = this.withCommandTimeout(args, proc.exited, async () => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // The process may have exited concurrently with the deadline.
      }
      await proc.exited.catch(() => undefined)
    })
    const [renderedStdout, renderedStderr, renderedExitCode] = await Promise.all([
      stdout,
      stderr,
      exitCode,
    ])

    if (renderedExitCode !== 0) {
      const rendered =
        renderedStderr.trim() ||
        renderedStdout.trim() ||
        `ghostmux exited with status ${renderedExitCode}`
      throw new Error(rendered)
    }

    return { stdout: renderedStdout, stderr: renderedStderr }
  }

  private withCommandTimeout<T>(
    args: string[],
    operation: Promise<T>,
    onTimeout?: (() => void | Promise<void>) | undefined
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void Promise.resolve()
          .then(() => onTimeout?.())
          .catch(() => undefined)
          .finally(() => {
            // The timeout is authoritative. Cleanup errors and a concurrent
            // process exit must never replace the typed deadline failure.
            reject(new GhostmuxCommandTimeoutError(args, this.commandTimeoutMs))
          })
      }, this.commandTimeoutMs)
      operation.then(
        (value) => {
          if (timedOut) return
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (timedOut) return
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }
}
