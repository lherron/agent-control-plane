/** One instance is owned by the acp-server lifecycle, shared by all consumers. */
export interface CommitWaker {
  /** Capture BEFORE reading the consumer's durable view/cursor. */
  token(): Promise<number>
  wait(
    since: number,
    options?: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }
  ): Promise<void>
}

type CommitWait = (params: { since?: string; timeoutMs: number }) => Promise<{
  token: string
  changed: boolean
}>

export class WrkqCommitWaker implements CommitWaker {
  private revision = 0
  private stopped = false
  private ready: Promise<void> | undefined
  private readonly subscribers = new Set<() => void>()
  private readonly shutdown = new AbortController()

  constructor(private readonly commitWait: CommitWait) {}

  async token(): Promise<number> {
    if (this.stopped) return this.revision
    this.ready ??= this.run()
    await this.ready
    return this.revision
  }

  async wait(
    since: number,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {}
  ): Promise<void> {
    if (this.stopped || options.signal?.aborted || since !== this.revision) return
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.subscribers.delete(finish)
        options.signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, Math.min(25_000, Math.max(0, options.timeoutMs ?? 25_000)))
      this.subscribers.add(finish)
      options.signal?.addEventListener('abort', finish, { once: true })
    })
  }

  stop(): void {
    this.stopped = true
    this.shutdown.abort()
    this.broadcast()
  }

  private broadcast(): void {
    this.revision++
    for (const finish of this.subscribers) finish()
  }

  private async run(): Promise<void> {
    // Bootstrap once before any subscriber reads. Subsequent RPC waits run in
    // the background; subscriber deadlines/abort never create more RPC waits.
    let token: string | undefined
    try {
      token = (await this.commitWait({ timeoutMs: 25_000 })).token
    } catch {
      // The retry loop below also wakes consumers at their ordinary interval.
    }
    if (!this.stopped) void this.pump(token)
  }

  private async pump(initialToken: string | undefined): Promise<void> {
    let token = initialToken
    while (!this.stopped) {
      const started = Date.now()
      let changed = false
      try {
        const result = await this.commitWait({
          ...(token !== undefined ? { since: token } : {}),
          timeoutMs: 25_000,
        })
        token = result.token
        changed = result.changed
      } catch {
        // Transport recovery is owned by the client; keep the cursor readers
        // alive, and pace errors just like a saturated (512 parked) server.
      }
      if (!changed && !this.stopped) {
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer)
            this.shutdown.signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, Math.max(0, 1_000 - (Date.now() - started)))
          this.shutdown.signal.addEventListener('abort', finish, { once: true })
        })
      }
      if (!this.stopped) this.broadcast()
    }
  }
}
