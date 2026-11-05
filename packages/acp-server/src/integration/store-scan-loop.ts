import { writeLogLine } from 'acp-core'
import {
  STORE_COMMIT_BACKSTOP_MS,
  type StoreCommitBus,
  type StoreCommitTopic,
} from '../store-commit-bus.js'

/** Snapshot before scanning, including across asynchronous scans. One scan at a time. */
export function createStoreScanLoop(input: {
  name: string
  bus?: StoreCommitBus | undefined
  topics: StoreCommitTopic[]
  scan(): Promise<void>
  nextDelayMs(): number
  retryDelayMs?: number | undefined
}) {
  let controller: AbortController | undefined
  let inflight: Promise<void> | undefined
  let scans = 0
  async function loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const versions = input.topics.map((topic) => input.bus?.version(topic) ?? 0)
      let timeoutMs = input.retryDelayMs ?? 2_000
      try {
        await input.scan()
        timeoutMs = Math.min(input.nextDelayMs(), STORE_COMMIT_BACKSTOP_MS)
      } catch (error) {
        writeLogLine({
          level: 'error',
          component: input.name,
          event: 'store_scan.failed',
          err: error,
        })
      }
      scans++
      writeLogLine({
        level: 'debug',
        component: input.name,
        event: 'store_scan.count',
        data: { scans },
      })
      if (signal.aborted) break
      const waitController = new AbortController()
      const abort = () => waitController.abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        const bus = input.bus
        if (bus !== undefined) {
          await Promise.race(
            input.topics.map((topic, i) =>
              bus.wait(topic, versions[i] ?? 0, { timeoutMs, signal: waitController.signal })
            )
          )
        } else {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs)
            waitController.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                resolve()
              },
              { once: true }
            )
          })
        }
      } finally {
        waitController.abort()
        signal.removeEventListener('abort', abort)
      }
    }
  }
  return {
    start() {
      if (controller !== undefined) return
      controller = new AbortController()
      inflight = loop(controller.signal)
    },
    async stop() {
      controller?.abort()
      await inflight
      controller = undefined
      inflight = undefined
    },
  }
}
