import { writeLogLine } from 'acp-core'
import { badRequest } from '../http.js'
import type { StoreCommitBus, StoreCommitTopic } from '../store-commit-bus.js'

export function readStorePageWaitMs(url: URL): number {
  const raw = url.searchParams.get('waitMs')
  if (raw === null) return 0
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(value) || value < 0 || value > 60_000) {
    badRequest('waitMs must be an integer from 0 to 60000', { field: 'waitMs' })
  }
  return value
}

const scanCounts = new Map<StoreCommitTopic, number>()

export async function readStorePage<T>(input: {
  bus?: StoreCommitBus | undefined
  topic: StoreCommitTopic
  waitMs: number
  signal: AbortSignal
  read(): T[]
}): Promise<T[]> {
  const version = input.bus?.version(input.topic) ?? 0
  const read = () => {
    const page = input.read()
    const scans = (scanCounts.get(input.topic) ?? 0) + 1
    scanCounts.set(input.topic, scans)
    writeLogLine({
      level: 'debug',
      component:
        input.topic === 'deliveries' ? 'discord-deliveries-page' : 'discord-lifecycle-page',
      event: 'store_scan.count',
      data: { scans },
    })
    return page
  }
  const page = read()
  if (page.length > 0 || input.waitMs === 0 || input.bus === undefined) return page
  await input.bus.wait(input.topic, version, { timeoutMs: input.waitMs, signal: input.signal })
  // A timeout without a commit returns the initial empty page. In particular,
  // immediate renewal performs only one scan per backstop interval at idle.
  return input.bus.version(input.topic) > version && !input.signal.aborted ? read() : page
}
