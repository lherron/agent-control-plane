export type StoreCommitTopic =
  | 'deliveries'
  | 'system-events'
  | 'coordination'
  | 'runs'
  | 'admissions'
  | 'jobs'
export const STORE_COMMIT_BACKSTOP_MS = 60_000

/** A process-local wake hint. Durable state always comes from a fresh store scan. */
export class StoreCommitBus {
  private closed = false
  private readonly versions = new Map<StoreCommitTopic, number>()
  private readonly waiters = new Map<StoreCommitTopic, Set<() => void>>()

  version(topic: StoreCommitTopic): number {
    return this.versions.get(topic) ?? 0
  }

  notify(topic: StoreCommitTopic): void {
    this.versions.set(topic, this.version(topic) + 1)
    for (const wake of [...(this.waiters.get(topic) ?? [])]) wake()
  }

  close(): void {
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const wake of [...waiters]) wake()
    }
  }

  wait(
    topic: StoreCommitTopic,
    sinceVersion: number,
    options: { timeoutMs: number; signal?: AbortSignal | undefined }
  ): Promise<void> {
    if (this.closed || this.version(topic) > sinceVersion || options.signal?.aborted)
      return Promise.resolve()
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', wake)
        this.waiters.get(topic)?.delete(wake)
        resolve()
      }
      let waiters = this.waiters.get(topic)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(topic, waiters)
      }
      waiters.add(wake)
      options.signal?.addEventListener('abort', wake, { once: true })
      const timer = setTimeout(
        wake,
        Math.max(0, Math.min(options.timeoutMs, STORE_COMMIT_BACKSTOP_MS))
      )
    })
  }
}
