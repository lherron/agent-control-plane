/**
 * Event pump: shared replay/buffer module for WebSocket endpoints.
 *
 * Encapsulates the two-cursor snapshot+live race-safe pattern:
 * 1. Start both async iterator pumps (events + messages) BEFORE snapshot.
 * 2. Both pumps buffer items in memory while the snapshot is being built.
 * 3. Read replay from the HRC store up to the current head.
 * 4. Capture replayHighWater = {hrcSeq, messageSeq}.
 * 5. Send snapshot via the emit callback.
 * 6. Drain each buffer: deliver only items strictly newer than that source's high-water.
 * 7. Continue forwarding live items as the iterators yield them.
 *
 * Used by both timeline-ws.ts and diagnostics-ws.ts.
 */

import type { HrcLifecycleEvent, HrcMessageRecord } from 'hrc-core'

import type { SnapshotHighWater } from './contracts.js'
import { createLogger } from './logger.js'

const log = createLogger({ component: 'event-pump' })

// ---------------------------------------------------------------------------
// HrcClient interface — the subset of HrcClient we actually need.
// This allows test fakes to be injected without importing the full SDK.
// ---------------------------------------------------------------------------

/** Minimal HRC client interface consumed by the event pump. */
export type EventPumpHrcClient = {
  /** Stream lifecycle events. With follow=true, stays open for live events. */
  watch(options?: {
    fromSeq?: number | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
    follow?: boolean | undefined
    signal?: AbortSignal | undefined
  }): AsyncIterable<HrcLifecycleEvent>

  /** Stream durable messages. With follow=true, stays open for live messages. */
  watchMessages(options?: {
    filter?: {
      afterSeq?: number | undefined
      hostSessionId?: string | undefined
      generation?: number | undefined
    }
    follow?: boolean | undefined
    signal?: AbortSignal | undefined
  }): AsyncIterable<HrcMessageRecord>
}

// ---------------------------------------------------------------------------
// Pump options & callbacks
// ---------------------------------------------------------------------------

/** Configuration for an event pump instance. */
export type EventPumpOptions = {
  /** HRC client (or fake) for streaming events and messages. */
  hrcClient: EventPumpHrcClient

  /** The sessionRef to filter events by (canonical format). */
  sessionRef: string

  /** Concrete host session selected for this mobile view. */
  hostSessionId?: string | undefined

  /** Concrete generation selected for this mobile view. */
  generation?: number | undefined

  /** Starting high-water for HRC lifecycle events (exclusive). */
  fromHrcSeq: number

  /** Starting high-water for hrcchat messages (exclusive). */
  fromMessageSeq: number

  /** AbortSignal — cancelled on WebSocket close. */
  signal: AbortSignal

  /**
   * Async callback to build and emit the snapshot. Receives the replay
   * events and messages collected from the store. Must return the
   * high-water marks captured from the most recent replay records.
   *
   * The pump will NOT emit any buffered items until this resolves.
   */
  buildSnapshot: (replay: {
    events: HrcLifecycleEvent[]
    messages: HrcMessageRecord[]
  }) => Promise<SnapshotHighWater>

  /**
   * Callback to emit a live HRC lifecycle event after the snapshot.
   * Called for each event that passes the session filter.
   */
  onEvent: (event: HrcLifecycleEvent) => void

  /**
   * Callback to emit a live hrcchat message after the snapshot.
   */
  onMessage: (message: HrcMessageRecord) => void

  /**
   * Optional filter predicate for events. When provided, only events
   * passing this predicate are emitted. Used by diagnostics for
   * category/eventKind filtering.
   */
  eventFilter?: ((event: HrcLifecycleEvent) => boolean) | undefined

  /**
   * Optional filter predicate for messages. When provided, only messages
   * passing this predicate are emitted.
   */
  messageFilter?: ((message: HrcMessageRecord) => boolean) | undefined
}

/** Result returned when the pump completes (normally or via cancellation). */
export type EventPumpResult = {
  /** Final high-water marks at the time the pump stopped. */
  highWater: SnapshotHighWater
  /** Whether the pump was cancelled via the AbortSignal. */
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Core pump implementation
// ---------------------------------------------------------------------------

/**
 * Run the event pump. This function drives the full lifecycle:
 *
 * 1. Start both async iterator pumps (buffering mode).
 * 2. Collect replay data from the iterators until they catch up.
 * 3. Call buildSnapshot with the replay data.
 * 4. Drain buffered items newer than snapshot high-water.
 * 5. Forward live items until the signal is aborted.
 *
 * Returns when the signal is aborted or both iterators close.
 */
export async function runEventPump(options: EventPumpOptions): Promise<EventPumpResult> {
  const {
    hrcClient,
    sessionRef,
    hostSessionId,
    generation,
    fromHrcSeq,
    fromMessageSeq,
    signal,
    buildSnapshot,
    onEvent,
    onMessage,
    eventFilter,
    messageFilter,
  } = options

  // High-water tracking
  let hrcHighWater = fromHrcSeq
  let messageHighWater = fromMessageSeq

  // Buffers for items arriving while the snapshot is being built
  const eventBuffer: HrcLifecycleEvent[] = []
  const messageBuffer: HrcMessageRecord[] = []

  // Phase tracking: 'buffering' → 'draining' → 'live'
  let phase: 'buffering' | 'draining' | 'live' = 'buffering'

  // Pump completion tracking
  let eventPumpDone = false
  let messagePumpDone = false

  // Resolve/reject for the overall pump
  let resolveResult: ((result: EventPumpResult) => void) | undefined
  let rejectResult: ((error: Error) => void) | undefined

  const resultPromise = new Promise<EventPumpResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  function finishIfBothDone(): void {
    if (eventPumpDone && messagePumpDone) {
      resolveResult?.({
        highWater: { hrcSeq: hrcHighWater, messageSeq: messageHighWater },
        cancelled: signal.aborted,
      })
    }
  }

  // Filter helper: check session relevance for events
  // scopeRef already includes the "agent:" prefix, e.g. "agent:cody:project:agent-spaces"
  function isRelevantEvent(event: HrcLifecycleEvent): boolean {
    const eventSessionRef = `${event.scopeRef}/lane:${event.laneRef}`
    if (eventSessionRef !== sessionRef) return false
    if (hostSessionId !== undefined && event.hostSessionId !== hostSessionId) return false
    if (generation !== undefined && event.generation !== generation) return false
    if (eventFilter && !eventFilter(event)) return false
    return true
  }

  function isRelevantMessage(message: HrcMessageRecord): boolean {
    if (hostSessionId !== undefined && message.execution.hostSessionId !== hostSessionId) {
      return false
    }
    if (generation !== undefined && message.execution.generation !== generation) {
      return false
    }
    if (messageFilter && !messageFilter(message)) return false
    return true
  }

  // --- Start event pump (async, runs in background) ---
  const runEventPumpAsync = async (): Promise<void> => {
    try {
      const iter = hrcClient.watch({
        ...(fromHrcSeq > 0 ? { fromSeq: fromHrcSeq } : {}),
        hostSessionId,
        generation,
        follow: true,
        signal,
      })

      for await (const event of iter) {
        if (signal.aborted) break

        if (!isRelevantEvent(event)) continue

        if (phase === 'buffering') {
          eventBuffer.push(event)
        } else {
          // 'draining' or 'live' — emit directly
          if (event.hrcSeq > hrcHighWater) {
            hrcHighWater = event.hrcSeq
            onEvent(event)
          }
        }
      }
    } catch (err: unknown) {
      // AbortError is expected on WebSocket close
      if (signal.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      log.error('event_pump.event_error', { message: msg })
    } finally {
      eventPumpDone = true
      finishIfBothDone()
    }
  }

  // --- Start message pump (async, runs in background) ---
  const runMessagePumpAsync = async (): Promise<void> => {
    try {
      const iter = hrcClient.watchMessages({
        filter: {
          afterSeq: fromMessageSeq,
          hostSessionId,
          generation,
        },
        follow: true,
        signal,
      })

      for await (const message of iter) {
        if (signal.aborted) break

        if (!isRelevantMessage(message)) continue

        if (phase === 'buffering') {
          messageBuffer.push(message)
        } else {
          // 'draining' or 'live' — emit directly
          if (message.messageSeq > messageHighWater) {
            messageHighWater = message.messageSeq
            onMessage(message)
          }
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      log.error('event_pump.message_error', { message: msg })
    } finally {
      messagePumpDone = true
      finishIfBothDone()
    }
  }

  // --- Main orchestration ---
  const orchestrate = async (): Promise<void> => {
    try {
      // 1. Start both pumps (they begin buffering immediately)
      const eventPumpPromise = runEventPumpAsync()
      const messagePumpPromise = runMessagePumpAsync()

      // 2. Build and send snapshot
      //    The snapshot builder reads from the store (replay) and returns high-water.
      //    While it's building, the pumps are buffering live items.
      if (signal.aborted) {
        resolveResult?.({
          highWater: { hrcSeq: hrcHighWater, messageSeq: messageHighWater },
          cancelled: true,
        })
        return
      }

      log.debug('event_pump.building_snapshot', {
        data: { sessionRef, fromHrcSeq, fromMessageSeq },
      })

      const snapshotHighWater = await buildSnapshot({
        events: [], // Replay data comes from the store, not the pump
        messages: [],
      })

      if (signal.aborted) {
        resolveResult?.({
          highWater: { hrcSeq: snapshotHighWater.hrcSeq, messageSeq: snapshotHighWater.messageSeq },
          cancelled: true,
        })
        return
      }

      // 3. Capture high-water from snapshot
      hrcHighWater = snapshotHighWater.hrcSeq
      messageHighWater = snapshotHighWater.messageSeq

      // 4. Drain buffers: only items strictly newer than high-water
      phase = 'draining'

      log.debug('event_pump.draining_buffers', {
        data: {
          eventBufferSize: eventBuffer.length,
          messageBufferSize: messageBuffer.length,
          hrcHighWater,
          messageHighWater,
        },
      })

      for (const event of eventBuffer) {
        if (signal.aborted) break
        if (event.hrcSeq > hrcHighWater) {
          hrcHighWater = event.hrcSeq
          onEvent(event)
        }
      }

      for (const message of messageBuffer) {
        if (signal.aborted) break
        if (message.messageSeq > messageHighWater) {
          messageHighWater = message.messageSeq
          onMessage(message)
        }
      }

      // 5. Switch to live mode — pumps now emit directly
      phase = 'live'
      eventBuffer.length = 0
      messageBuffer.length = 0

      log.debug('event_pump.live', {
        data: { sessionRef, hrcHighWater, messageHighWater },
      })

      // Wait for both pumps to complete (they run until signal abort or iterator close)
      await Promise.allSettled([eventPumpPromise, messagePumpPromise])
    } catch (err: unknown) {
      if (signal.aborted) {
        resolveResult?.({
          highWater: { hrcSeq: hrcHighWater, messageSeq: messageHighWater },
          cancelled: true,
        })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        log.error('event_pump.orchestration_error', { message: msg })
        rejectResult?.(err instanceof Error ? err : new Error(msg))
      }
    }
  }

  // Kick off orchestration (don't await — it resolves via resultPromise)
  orchestrate()

  return resultPromise
}
