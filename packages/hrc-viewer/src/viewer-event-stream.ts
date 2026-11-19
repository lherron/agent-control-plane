import type { HrcEventTail } from 'hrc-sdk'

import type {
  HrcViewerClient,
  HrcViewerOptions,
  LifecycleEvent,
  ViewerLog,
  ViewerWarn,
} from './viewer-contracts.js'

type ViewerStreamOptions = Pick<HrcViewerOptions, 'reconnectDelaysMs' | 'streamStableAfterMs'> & {
  client: Pick<HrcViewerClient, 'health' | 'tailEvents' | 'watchBoundedEvents'>
  now: () => number
  isStopped: () => boolean
  reconcile: (reason: 'start' | 'reconnect' | 'stream_reset') => Promise<void>
  handleEvent: (event: LifecycleEvent) => Promise<void>
  log: ViewerLog
  warn: ViewerWarn
}

const DEFAULT_RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000] as const
// Streams close by design. Fast closes escalate backoff (T-08296).
const DEFAULT_STREAM_STABLE_AFTER_MS = 5_000

export async function watchViewerEvents(
  options: ViewerStreamOptions,
  signal?: AbortSignal
): Promise<void> {
  const {
    client,
    now,
    isStopped,
    reconcile,
    warn,
    reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
    streamStableAfterMs = DEFAULT_STREAM_STABLE_AFTER_MS,
  } = options
  let failures = 0
  let everStarted = false
  while (!isStopped()) {
    let streamStartedAt: number | undefined
    try {
      await client.health()
      const tail = await client.tailEvents({ limit: 1 })
      await reconcile(everStarted ? 'reconnect' : 'start')
      everStarted = true
      streamStartedAt = now()
      await consumeStream(options, tail, signal)
      if (!isStopped()) {
        throw new Error('bounded event stream closed')
      }
    } catch (error) {
      if (isStopped()) break
      const streamMs = streamStartedAt === undefined ? undefined : now() - streamStartedAt
      if (streamMs !== undefined && streamMs >= streamStableAfterMs) {
        failures = 0
      }
      const index = Math.min(failures, reconnectDelaysMs.length - 1)
      const delayMs = reconnectDelaysMs[index] ?? 4_000
      warn('broker_headless_viewer.stream_failed', error, {
        failures,
        delayMs,
        ...(streamMs !== undefined ? { streamMs } : {}),
      })
      failures += 1
      await delay(delayMs, signal)
    }
  }
}

async function consumeStream(
  { client, log, warn, reconcile, handleEvent }: ViewerStreamOptions,
  tail: HrcEventTail,
  signal?: AbortSignal
): Promise<void> {
  const expectedIncarnation = tail.ledgerIncarnationId
  let afterSeq = tail.headHrcSeq
  for await (const record of client.watchBoundedEvents({
    ledgerIncarnationId: expectedIncarnation,
    afterSeq,
    ...(signal !== undefined ? { signal } : {}),
  })) {
    if (record.type === 'ledger_replaced') {
      log('WARN', 'broker_headless_viewer.ledger_replaced', {
        expectedLedgerIncarnationId: record.expectedLedgerIncarnationId,
        currentLedgerIncarnationId: record.currentLedgerIncarnationId,
      })
      await reconcile('stream_reset')
      return
    }
    if (record.type === 'home_unreachable') {
      log('WARN', 'broker_headless_viewer.home_unreachable', {
        homeNodeId: record.homeNodeId,
        reason: record.reason,
      })
      await reconcile('stream_reset')
      return
    }
    if (record.ledgerIncarnationId !== expectedIncarnation) {
      throw new Error('bounded stream incarnation changed without ledger_replaced')
    }
    if (record.type === 'ready') {
      if (record.acceptedAfterHrcSeq !== afterSeq) {
        throw new Error('bounded stream admitted a different start position')
      }
      continue
    }
    if (record.type === 'gap') {
      log('WARN', 'broker_headless_viewer.stream_gap', {
        reason: record.reason,
        afterHrcSeq: record.afterHrcSeq,
        beforeHrcSeq: record.beforeHrcSeq,
        dropped: record.dropped,
      })
      await reconcile('stream_reset')
      return
    }
    afterSeq = record.event.hrcSeq
    try {
      await handleEvent(record.event)
    } catch (error) {
      warn('broker_headless_viewer.event_failed', error, {
        eventKind: record.event.eventKind,
        hrcSeq: record.event.hrcSeq,
      })
    }
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
