import type { HrcViewerOptions, ViewerGhostmux, ViewerLog, ViewerWarn } from './viewer-contracts.js'

/** Owns the linger timers and reaps panes using their runtime fence. */
export class ViewerPaneReaper {
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly scheduleTimer: NonNullable<HrcViewerOptions['schedule']>
  private readonly clearScheduled: NonNullable<HrcViewerOptions['clearScheduled']>

  constructor(
    private readonly ghostmux: Pick<ViewerGhostmux, 'reapHeadlessAgentPane'>,
    private readonly lingerSeconds: number,
    private readonly now: () => number,
    private readonly log: ViewerLog,
    private readonly warn: ViewerWarn,
    options: Pick<HrcViewerOptions, 'schedule' | 'clearScheduled'>
  ) {
    this.scheduleTimer = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearScheduled = options.clearScheduled ?? ((handle) => clearTimeout(handle))
  }

  clear(): void {
    for (const timer of this.reapTimers.values()) this.clearScheduled(timer)
    this.reapTimers.clear()
  }

  schedule(surfaceId: string, runtimeId: string, scopeRef: string, terminalAtMs: number): void {
    if (this.reapTimers.has(runtimeId)) return
    const remainingMs = Math.max(0, terminalAtMs + this.lingerSeconds * 1_000 - this.now())
    this.log('INFO', 'headless_viewer_reap.linger_scheduled', {
      runtimeId,
      scopeRef,
      surfaceId,
      lingerSeconds: Math.ceil(remainingMs / 1_000),
    })
    const timer = this.scheduleTimer(() => {
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
}
