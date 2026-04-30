/**
 * WS /v1/timeline — projected timeline frames + control messages.
 *
 * Accepts query: ?sessionRef=<encoded>&hostSessionId=<optional>&generation=<optional>&fromHrcSeq=<n>&fromMessageSeq=<n>&raw=<bool>
 *
 * Open sequence:
 * 1. Parse query params, validate sessionRef.
 * 2. Start both async iterator pumps BEFORE snapshot (via event-pump).
 * 3. Build snapshot: project replay through reducer → SnapshotMessage with HistoryPage.
 * 4. Send snapshot.
 * 5. Drain buffers, then forward live events+messages as FrameMessage and optionally HrcEventMessage.
 * 6. On close: cancel both iterators via AbortController.
 */

import type { ServerWebSocket } from 'bun'
import type { HrcLifecycleEvent, HrcMessageRecord } from 'hrc-core'

import type {
  FrameMessage,
  GatewayWsMessage,
  HrcEventMessage,
  MobileSessionSummary,
  SnapshotHighWater,
  SnapshotMessage,
  TimelineFrame,
} from './contracts.js'
import type { EventPumpHrcClient } from './event-pump.js'
import { runEventPump } from './event-pump.js'
import { createReducerState, reduce } from './event-reducer.js'
import { createLogger } from './logger.js'
import { type TimelineHistoryClient, projectPastWindow } from './timeline-history.js'
import type { ReducerInput } from './types.js'

const log = createLogger({ component: 'timeline-ws' })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data attached to each WebSocket connection for the timeline route. */
export type TimelineWsData = {
  sessionRef: string
  hostSessionId: string | undefined
  generation: number | undefined
  fromHrcSeq: number
  fromMessageSeq: number
  raw: boolean
  abortController: AbortController
}

/** Default number of past frames to include in the snapshot. */
const SNAPSHOT_HISTORY_LIMIT = 50

/** Dependencies injected into the timeline WS handler. */
export type TimelineWsDeps = {
  hrcClient: EventPumpHrcClient
  /** HRC client for querying past events/messages (history paging). */
  historyClient: TimelineHistoryClient
  /** Resolve a session summary from sessionRef plus optional hostSessionId. */
  resolveSession: (selector: {
    sessionRef: string
    hostSessionId?: string | undefined
    generation?: number | undefined
  }) => Promise<MobileSessionSummary>
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the timeline WebSocket handler functions for Bun.serve.
 */
export function createTimelineWsHandler(deps: TimelineWsDeps) {
  return {
    /**
     * Called on WS upgrade. Parse query params and attach data.
     * Returns the TimelineWsData to attach, or null to reject.
     */
    parseUpgrade(url: URL): TimelineWsData | null {
      const sessionRef = url.searchParams.get('sessionRef')
      if (!sessionRef) return null

      const hostSessionId = url.searchParams.get('hostSessionId')?.trim() || undefined
      const generationRaw = url.searchParams.get('generation')
      const generation =
        generationRaw === null || generationRaw.trim().length === 0
          ? undefined
          : Number.parseInt(generationRaw, 10)
      const fromHrcSeq = Number.parseInt(url.searchParams.get('fromHrcSeq') ?? '0', 10)
      const fromMessageSeq = Number.parseInt(url.searchParams.get('fromMessageSeq') ?? '0', 10)
      const raw = url.searchParams.get('raw') === 'true'

      return {
        sessionRef,
        hostSessionId,
        generation: Number.isFinite(generation) ? generation : undefined,
        fromHrcSeq: Number.isFinite(fromHrcSeq) ? fromHrcSeq : 0,
        fromMessageSeq: Number.isFinite(fromMessageSeq) ? fromMessageSeq : 0,
        raw,
        abortController: new AbortController(),
      }
    },

    /**
     * Called when the WebSocket opens. Starts the event pump.
     */
    async open(ws: ServerWebSocket<TimelineWsData>): Promise<void> {
      const {
        sessionRef,
        hostSessionId,
        generation,
        fromHrcSeq,
        fromMessageSeq,
        raw,
        abortController,
      } = ws.data

      log.info('timeline_ws.open', {
        data: { sessionRef, hostSessionId, generation, fromHrcSeq, fromMessageSeq, raw },
      })

      // Track reducer state for incremental projection
      let reducerState = createReducerState()
      let frameSeqCounter = 1

      // Helper: send a message to the WebSocket
      const send = (msg: GatewayWsMessage): void => {
        if (abortController.signal.aborted) return
        try {
          ws.send(JSON.stringify(msg))
        } catch {
          // WS may have closed between check and send
        }
      }

      try {
        // Resolve session info
        // If hostSessionId is absent, the resolver must choose the active/latest
        // generation for this sessionRef only; sibling generations stay isolated.
        const session = await deps.resolveSession({ sessionRef, hostSessionId, generation })

        await runEventPump({
          hrcClient: deps.hrcClient,
          sessionRef,
          hostSessionId: session.hostSessionId,
          generation: session.generation,
          fromHrcSeq,
          fromMessageSeq,
          signal: abortController.signal,

          // Build snapshot: query past events/messages from the HRC store,
          // project through the reducer, and send the populated snapshot.
          // This runs AFTER live pumps have started buffering, so any events
          // arriving during this window are captured in the pump buffers and
          // drained after the snapshot (race-safe).
          async buildSnapshot(_replay) {
            // Query past events/messages using the shared projector from
            // timeline-history.ts — same logic as GET /v1/history.
            // beforeHrcSeq/beforeMessageSeq = undefined → query from head.
            const history = await projectPastWindow(deps.historyClient, {
              sessionRef,
              hostSessionId: session.hostSessionId,
              generation: session.generation,
              beforeHrcSeq: undefined,
              beforeMessageSeq: undefined,
              limit: SNAPSHOT_HISTORY_LIMIT,
            })

            // Snapshot high-water = newest cursors from the projected window.
            // The pump will only emit buffered items strictly newer than this.
            const snapshotHighWater: SnapshotHighWater = {
              hrcSeq: Math.max(fromHrcSeq, history.newestCursor.hrcSeq),
              messageSeq: Math.max(fromMessageSeq, history.newestCursor.messageSeq),
            }

            // Seed reducer state with snapshot frames so live updates to
            // the same frameIds merge correctly (no duplication). The
            // frameId IS the identity key used by the reducer's frame map.
            for (const frame of history.frames) {
              const appliedHrcSeqs = new Set<number>()
              for (const src of frame.sourceEvents) {
                appliedHrcSeqs.add(src.hrcSeq)
              }
              reducerState.frames.set(frame.frameId, { frame, appliedHrcSeqs })
            }
            if (history.frames.length > 0) {
              reducerState.nextFrameSeq = history.frames.length + 1
              reducerState.highWaterHrcSeq = snapshotHighWater.hrcSeq
              reducerState.highWaterMessageSeq = snapshotHighWater.messageSeq
              frameSeqCounter = history.frames.length + 1
            }

            const snapshotMsg: SnapshotMessage = {
              type: 'snapshot',
              session,
              snapshotHighWater,
              history,
            }

            send(snapshotMsg)

            return snapshotHighWater
          },

          // Emit live HRC event: project through reducer → FrameMessage
          onEvent(event: HrcLifecycleEvent) {
            const input: ReducerInput = { kind: 'event', event }
            const result = reduce(reducerState, input)
            reducerState = result.state

            for (const update of result.frameUpdates) {
              if (update.action === 'create' || update.action === 'update') {
                // Override frameSeq with wire delivery order
                const frame: TimelineFrame = {
                  ...update.frame,
                  frameSeq: frameSeqCounter++,
                }

                const frameMsg: FrameMessage = {
                  type: 'frame',
                  frame,
                }
                send(frameMsg)
              }
            }

            // If raw mode, also send the raw event
            if (raw) {
              const hrcEventMsg: HrcEventMessage = {
                type: 'hrc_event',
                hrcSeq: event.hrcSeq,
                streamSeq: event.streamSeq,
                eventKind: event.eventKind,
                category: event.category,
                ts: event.ts,
                payload: event.payload,
              }
              send(hrcEventMsg)
            }
          },

          // Emit live message: project through reducer → FrameMessage
          onMessage(message: HrcMessageRecord) {
            const input: ReducerInput = { kind: 'message', message }
            const result = reduce(reducerState, input)
            reducerState = result.state

            for (const update of result.frameUpdates) {
              if (update.action === 'create' || update.action === 'update') {
                const frame: TimelineFrame = {
                  ...update.frame,
                  frameSeq: frameSeqCounter++,
                }

                const frameMsg: FrameMessage = {
                  type: 'frame',
                  frame,
                }
                send(frameMsg)
              }
            }
          },
        })
      } catch (err: unknown) {
        if (!abortController.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err)
          log.error('timeline_ws.error', { message: msg })
          send({ type: 'error', code: 'INTERNAL_ERROR', message: msg })
        }
      }
    },

    /**
     * Called when the WebSocket closes. Cancel all pumps.
     */
    close(ws: ServerWebSocket<TimelineWsData>): void {
      log.info('timeline_ws.close', {
        data: { sessionRef: ws.data.sessionRef },
      })
      ws.data.abortController.abort()
    },

    /**
     * Called when a message is received from the client.
     * Timeline WS is server→client only; client messages are ignored
     * except for pong responses.
     */
    message(ws: ServerWebSocket<TimelineWsData>, message: string | Buffer): void {
      try {
        const text = typeof message === 'string' ? message : message.toString()
        const parsed = JSON.parse(text)
        if (parsed?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
        }
      } catch {
        // Ignore malformed client messages
      }
    },
  }
}
