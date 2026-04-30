/**
 * WS /v1/diagnostics/events — raw HRC event stream for diagnostics.
 *
 * Accepts query: ?sessionRef=<encoded>&hostSessionId=<optional>&generation=<optional>&fromHrcSeq=<n>&category=<optional>&eventKind=<optional>&follow=true
 *
 * Reuses the SAME replay/buffer plumbing from event-pump.ts.
 * Filters lifecycle events by category/eventKind.
 * Emits ONLY {type: 'hrc_event', ...} envelopes — no projection.
 * Preserves canonical eventKind, category, full payload.
 */

import type { ServerWebSocket } from 'bun'
import type { HrcLifecycleEvent } from 'hrc-core'

import type { GatewayWsMessage, HrcEventMessage, SnapshotHighWater } from './contracts.js'
import { matchesCategory, matchesEventKind } from './event-filter.js'
import type { EventPumpHrcClient } from './event-pump.js'
import { runEventPump } from './event-pump.js'
import { createLogger } from './logger.js'
import { resolveSessionGeneration } from './session-generation.js'
import type { SessionGenerationClient } from './session-generation.js'

const log = createLogger({ component: 'diagnostics-ws' })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data attached to each WebSocket connection for the diagnostics route. */
export type DiagnosticsWsData = {
  sessionRef: string
  hostSessionId: string | undefined
  generation: number | undefined
  fromHrcSeq: number
  category: string | undefined
  eventKind: string | undefined
  abortController: AbortController
}

/** Dependencies injected into the diagnostics WS handler. */
export type DiagnosticsWsDeps = {
  hrcClient: EventPumpHrcClient & SessionGenerationClient
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the diagnostics WebSocket handler functions for Bun.serve.
 */
export function createDiagnosticsWsHandler(deps: DiagnosticsWsDeps) {
  return {
    /**
     * Called on WS upgrade. Parse query params and attach data.
     * Returns the DiagnosticsWsData to attach, or null to reject.
     */
    parseUpgrade(url: URL): DiagnosticsWsData | null {
      const sessionRef = url.searchParams.get('sessionRef')
      if (!sessionRef) return null

      const hostSessionId = url.searchParams.get('hostSessionId')?.trim() || undefined
      const generationRaw = url.searchParams.get('generation')
      const generation =
        generationRaw === null || generationRaw.trim().length === 0
          ? undefined
          : Number.parseInt(generationRaw, 10)
      const fromHrcSeq = Number.parseInt(url.searchParams.get('fromHrcSeq') ?? '0', 10)
      const category = url.searchParams.get('category') ?? undefined
      const eventKind = url.searchParams.get('eventKind') ?? undefined

      return {
        sessionRef,
        hostSessionId,
        generation: Number.isFinite(generation) ? generation : undefined,
        fromHrcSeq: Number.isFinite(fromHrcSeq) ? fromHrcSeq : 0,
        category,
        eventKind,
        abortController: new AbortController(),
      }
    },

    /**
     * Called when the WebSocket opens. Starts the event pump
     * in raw mode — no projection, only hrc_event envelopes.
     */
    async open(ws: ServerWebSocket<DiagnosticsWsData>): Promise<void> {
      const {
        sessionRef,
        hostSessionId,
        generation,
        fromHrcSeq,
        category,
        eventKind,
        abortController,
      } = ws.data

      log.info('diagnostics_ws.open', {
        data: { sessionRef, hostSessionId, generation, fromHrcSeq, category, eventKind },
      })

      // Helper: send a message to the WebSocket
      const send = (msg: GatewayWsMessage): void => {
        if (abortController.signal.aborted) return
        try {
          ws.send(JSON.stringify(msg))
        } catch {
          // WS may have closed between check and send
        }
      }

      // Category/eventKind filter for the pump
      const filterFn = (event: HrcLifecycleEvent): boolean => {
        return matchesCategory(event, category) && matchesEventKind(event, eventKind)
      }

      try {
        // If hostSessionId is absent, resolve to this sessionRef's active/latest
        // generation only. Diagnostics must not fan out across sibling rows.
        const selected = await resolveSessionGeneration(deps.hrcClient, {
          sessionRef,
          hostSessionId,
          generation,
        })

        await runEventPump({
          hrcClient: deps.hrcClient,
          sessionRef,
          hostSessionId: selected.hostSessionId,
          generation: selected.generation,
          fromHrcSeq,
          fromMessageSeq: 0, // Diagnostics doesn't use messages
          signal: abortController.signal,

          eventFilter: filterFn,

          // Build snapshot: diagnostics sends a minimal snapshot with just the high-water
          async buildSnapshot(_replay) {
            const snapshotHighWater: SnapshotHighWater = {
              hrcSeq: fromHrcSeq,
              messageSeq: 0,
            }

            // Send a lightweight snapshot so the client knows the stream is ready
            send({
              type: 'snapshot',
              session: {
                sessionRef,
                displayRef: sessionRef,
                title: 'Diagnostics',
                mode: 'interactive',
                executionMode: 'interactive',
                status: 'active',
                hostSessionId: selected.hostSessionId,
                generation: selected.generation,
                runtimeId: null,
                activeTurnId: null,
                lastHrcSeq: fromHrcSeq,
                lastMessageSeq: 0,
                lastActivityAt: null,
                capabilities: {
                  input: false,
                  interrupt: false,
                  launchHeadlessTurn: false,
                  history: false,
                },
              },
              snapshotHighWater,
              history: {
                frames: [],
                oldestCursor: { hrcSeq: fromHrcSeq, messageSeq: 0 },
                newestCursor: { hrcSeq: fromHrcSeq, messageSeq: 0 },
                hasMoreBefore: false,
              },
            })

            return snapshotHighWater
          },

          // Emit raw HRC event — no projection, preserve full payload
          onEvent(event: HrcLifecycleEvent) {
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
          },

          // Messages are not used in diagnostics — ignore
          onMessage() {},
        })
      } catch (err: unknown) {
        if (!abortController.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err)
          log.error('diagnostics_ws.error', { message: msg })
          send({ type: 'error', code: 'INTERNAL_ERROR', message: msg })
        }
      }
    },

    /**
     * Called when the WebSocket closes. Cancel all pumps.
     */
    close(ws: ServerWebSocket<DiagnosticsWsData>): void {
      log.info('diagnostics_ws.close', {
        data: { sessionRef: ws.data.sessionRef },
      })
      ws.data.abortController.abort()
    },

    /**
     * Called when a message is received from the client.
     */
    message(ws: ServerWebSocket<DiagnosticsWsData>, message: string | Buffer): void {
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
