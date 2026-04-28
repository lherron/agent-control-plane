import type { RawAcpRequester } from './shared.js'

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'succeeded'])

export type PollOptions = {
  /** Polling interval in milliseconds. */
  intervalMs: number
  /** Total timeout in milliseconds. */
  timeoutMs: number
}

export type PollResult<T> = {
  latest: T
  timedOut: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Generic status-polling loop.
 *
 * Calls `pollFn` repeatedly until `isTerminal(latest)` returns true or the
 * timeout elapses.
 */
export async function pollUntilTerminal<T>(options: {
  initial: T
  isTerminal: (value: T) => boolean
  pollFn: () => Promise<T>
  intervalMs: number
  timeoutMs: number
}): Promise<PollResult<T>> {
  const deadline = Date.now() + options.timeoutMs
  let latest = options.initial
  let timedOut = false

  while (!options.isTerminal(latest)) {
    if (Date.now() >= deadline) {
      timedOut = true
      break
    }
    await sleep(options.intervalMs)
    latest = await options.pollFn()
  }

  return { latest, timedOut }
}

/**
 * Poll GET /v1/job-runs/:id until the job-run reaches a terminal status.
 */
export async function pollJobRun(
  requester: RawAcpRequester,
  jobRunId: string,
  options: PollOptions
): Promise<PollResult<Record<string, unknown>>> {
  const initial = await requester.requestJson<{ jobRun: Record<string, unknown> }>({
    method: 'GET',
    path: `/v1/job-runs/${encodeURIComponent(jobRunId)}`,
  })

  return pollUntilTerminal({
    initial: initial.jobRun,
    isTerminal: (jr) => TERMINAL_STATUSES.has(String(jr['status'] ?? '')),
    pollFn: async () => {
      const polled = await requester.requestJson<{ jobRun: Record<string, unknown> }>({
        method: 'GET',
        path: `/v1/job-runs/${encodeURIComponent(jobRunId)}`,
      })
      return polled.jobRun
    },
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
  })
}
