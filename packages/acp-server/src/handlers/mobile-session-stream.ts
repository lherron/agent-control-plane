import { type HrcLifecycleEvent, splitSessionRef } from 'hrc-core'
import type { CollaborationMessage } from 'wrkq-lib'
import type { AcpHrcClient } from '../deps.js'
import type { RelayedBoundedEventRecord } from '../hrc-relay-record.js'
import type { createMobileTimelineProjector } from '../mobile-timeline-projector.js'
import { isRecord } from '../parsers/body.js'
import {
  type MobileReadSession,
  resolveMobileSessionForRead,
  sessionHomeRefusal,
} from './mobile-session-access.js'
import { projectEvent, projectSession, sessionRef } from './mobile-session-projection.js'
import {
  MOBILE_COLLABORATION_MATCH_WINDOW_MS,
  type MobileTimelineFrame,
  type ProjectedCollaborationFrame,
  closestCollaborationMatch,
  mergeCollaborationIdentity,
  mobileTimelineProjector,
  projectCollaborationMessage,
  projectFrame,
  projectPrimaryEvent,
} from './mobile-timeline.js'
import {
  type MobileWebSocketLike,
  parseMobileEventCursor,
  parseMobileMessageCursor,
  parseMobileRawFlag,
  parseMobileSessionDetailsFlag,
  sendMobileErrorEnvelope,
  sendMobileJsonEnvelope,
} from './mobile-ws.js'
import { recordDisposition } from './session-disposition.js'
import { formatSessionIdentityHandle } from './shared.js'

export async function openMobileSessionWebSocket(
  ws: MobileWebSocketLike,
  hrcClient: AcpHrcClient,
  parsedURL: URL,
  pathHostSessionId: string,
  requestedSessionRef: string | undefined
): Promise<void> {
  const { deps, kind, abortController } = ws.data
  let fromMessageSeq = parseMobileMessageCursor(parsedURL)
  const raw = parseMobileRawFlag(parsedURL)
  const includeSessionDetails = parseMobileSessionDetailsFlag(parsedURL)
  const cursor = parseMobileEventCursor(parsedURL)
  const options = {
    ...cursor,
    // Path-derived hostSessionId takes precedence over any query value.
    hostSessionId: pathHostSessionId,
    follow: true,
    signal: abortController.signal,
  }
  let liveFrameSeq = 1
  let sessionRefValue: string | undefined
  let activeTimelineProjector: ReturnType<typeof createMobileTimelineProjector> | undefined
  let timelineHrcLedgerIncarnationId: string | undefined
  let timelineWrkqLedgerIncarnationId: string | undefined
  let timelineIdentity:
    | { sessionRef: string; hostSessionId: string; generation: number; memberRef: string }
    | undefined

  if (kind === 'timeline') {
    let resolved: MobileReadSession
    try {
      resolved = await resolveMobileSessionForRead(hrcClient, {
        hostSessionId: pathHostSessionId,
        sessionRef: requestedSessionRef,
      })
    } catch (error) {
      const refusal = sessionHomeRefusal(error)
      if (refusal !== undefined) {
        sendMobileJsonEnvelope(ws, { type: 'error', ...refusal, retryable: true })
        ws.close(1013, 'session home unavailable')
        return
      }
      sendMobileErrorEnvelope(
        ws,
        'session_not_found',
        error instanceof Error ? error.message : String(error)
      )
      ws.close(1008, 'session not found')
      return
    }
    const { record, runtime } = resolved
    sessionRefValue = sessionRef(record.scopeRef, record.laneRef)
    // T-10418 §5.5: a remote record's snapshot reads the home by its exact
    // scope, lane, host and generation; never local by hostSessionId alone.
    const exact = {
      scopeRef: record.scopeRef,
      laneRef: record.laneRef,
      hostSessionId: record.hostSessionId,
      generation: record.generation,
    }
    const [lastEvent, latestRun] = resolved.remote
      ? await Promise.all([
          hrcClient.tailEvents({ ...exact, limit: 1 }).then((tail) => tail.events.at(-1)),
          hrcClient.listRuns({ ...exact, limit: 1 }).then((runs) => runs[0]),
        ])
      : await Promise.all([
          hrcClient
            .listLatestEventBySession({
              hostSessionId: record.hostSessionId,
              generation: record.generation,
            })
            .then((events) => events[0]),
          hrcClient.getLatestRunForSession({
            hostSessionId: record.hostSessionId,
            generation: record.generation,
          }),
        ])
    const projectedSession = projectSession({
      record,
      runtime,
      run: latestRun ?? undefined,
      lastEvent,
      raw,
      includeSessionDetails,
    })
    const session = {
      ...projectedSession,
      // HRC's continuity get answers for this node; a remote record carries null.
      ...(resolved.remote
        ? { disposition: null, dispositionAt: null }
        : await recordDisposition(hrcClient, record, projectedSession, runtime)),
    }
    if (deps.stateStore === undefined || deps.collaborationLedger === undefined) {
      sendMobileErrorEnvelope(ws, 'timeline_unavailable', 'timeline projection is not configured')
      ws.close(1011, 'timeline unavailable')
      return
    }
    const memberRef = formatSessionIdentityHandle(record.scopeRef, record.identity)
    timelineIdentity = {
      sessionRef: sessionRefValue,
      hostSessionId: record.hostSessionId,
      generation: record.generation,
      memberRef,
    }
    activeTimelineProjector = mobileTimelineProjector(deps, hrcClient)
    const projected = await activeTimelineProjector.open(timelineIdentity, { target: 50 })
    const activeProjection = await deps.stateStore.mobileTimeline.getActive(timelineIdentity)
    if (activeProjection === undefined) {
      throw new Error('mobile timeline projection disappeared after open')
    }
    timelineHrcLedgerIncarnationId = activeProjection.hrcLedgerIncarnationId
    timelineWrkqLedgerIncarnationId = activeProjection.wrkqLedgerIncarnationId
    const frames = projected.atoms
      .map((atom) => atom.payload['frame'])
      .filter((frame): frame is MobileTimelineFrame => isRecord(frame))
      .map((frame, index) => ({ ...frame, frameSeq: index + 1, sessionRef: sessionRefValue }))
    const history = {
      projectionEpoch: projected.projectionEpoch,
      atoms: projected.atoms,
      frames,
      olderCursor: projected.olderCursor,
      hasMoreBefore: projected.hasMoreBefore,
      oldestCursor: {
        hrcSeq: projected.atoms.find((atom) => atom.sourceKind === 'hrc')?.sourceSeq ?? 0,
        messageSeq: projected.atoms.find((atom) => atom.sourceKind === 'wrkq')?.sourceSeq ?? 0,
      },
      newestCursor: projected.highWater,
      ...(projected.resetReason !== undefined ? { resetReason: projected.resetReason } : {}),
    }
    liveFrameSeq = (history.frames.at(-1)?.frameSeq ?? 0) + 1
    // The snapshot establishes the baseline up to history.newestCursor. Advance
    // the live follow cursors to that high-water so pumpEvents/pumpMessages do
    // not re-emit already-snapshotted events/messages as fresh live frames
    // (which would append stale, out-of-order content below the snapshot).
    if (options.fromSeq === undefined || history.newestCursor.hrcSeq > options.fromSeq) {
      options.fromSeq = history.newestCursor.hrcSeq
    }
    if (history.newestCursor.messageSeq > fromMessageSeq) {
      fromMessageSeq = history.newestCursor.messageSeq
    }
    sendMobileJsonEnvelope(ws, {
      type: 'snapshot',
      session,
      snapshotHighWater: history.newestCursor,
      projectionEpoch: projected.projectionEpoch,
      ...(projected.resetReason !== undefined ? { resetReason: projected.resetReason } : {}),
      history,
    })
  }

  try {
    if (kind === 'diagnostics') {
      for await (const event of hrcClient.watch(options)) {
        if (abortController.signal.aborted) break
        sendMobileJsonEnvelope(ws, projectEvent(event))
      }
      return
    }

    const sendFrame = (frame: MobileTimelineFrame | undefined): void => {
      if (frame === undefined || abortController.signal.aborted) return
      sendMobileJsonEnvelope(ws, {
        type: 'frame',
        frame: { ...frame, frameSeq: liveFrameSeq++ },
      })
    }

    const sendAtoms = (
      atoms: Awaited<ReturnType<NonNullable<typeof activeTimelineProjector>['admitLiveHrc']>>
    ): void => {
      for (const atom of atoms) {
        sendMobileJsonEnvelope(ws, {
          type: 'atom',
          projectionEpoch: atom.projectionEpoch,
          atom,
        })
      }
    }

    const memberRef = timelineIdentity?.memberRef
    const liveMessageFloor = Number.isFinite(fromMessageSeq) ? fromMessageSeq : 0
    const handledMessageIds = new Set<string>()
    const pendingCollaborations = new Map<
      string,
      ProjectedCollaborationFrame & { timer: ReturnType<typeof setTimeout> }
    >()
    let liveMergeQueue = Promise.resolve()

    const queueLiveMerge = (operation: () => void | Promise<void>): Promise<void> => {
      const queued = liveMergeQueue.then(operation)
      liveMergeQueue = queued.catch(() => undefined)
      return queued
    }

    const clearPendingCollaboration = (messageId: string): void => {
      const pending = pendingCollaborations.get(messageId)
      if (pending !== undefined) clearTimeout(pending.timer)
      pendingCollaborations.delete(messageId)
    }

    const flushPendingCollaboration = async (messageId: string): Promise<void> => {
      const pending = pendingCollaborations.get(messageId)
      if (pending === undefined || handledMessageIds.has(messageId)) return
      pendingCollaborations.delete(messageId)
      handledMessageIds.add(messageId)
      if (activeTimelineProjector !== undefined && timelineIdentity !== undefined) {
        sendAtoms(
          await activeTimelineProjector.admitLiveCollaboration(timelineIdentity, pending.message)
        )
      }
      sendFrame(pending.frame)
    }

    const recentLiveCollaborations = async (): Promise<ProjectedCollaborationFrame[]> => {
      if (
        sessionRefValue === undefined ||
        memberRef === undefined ||
        deps.collaborationLedger === undefined ||
        timelineWrkqLedgerIncarnationId === undefined
      ) {
        return []
      }
      const messages: CollaborationMessage[] = []
      let afterMessageSeq = liveMessageFloor
      while (!abortController.signal.aborted) {
        const page = await deps.collaborationLedger.pageMessagesByMember({
          memberRef,
          afterMessageSeq,
          expectedLedgerIncarnationId: timelineWrkqLedgerIncarnationId,
          limit: 500,
        })
        messages.push(...page.messages)
        afterMessageSeq = page.messages.at(-1)?.messageSeq ?? afterMessageSeq
        if (!page.hasMoreAfter) break
      }
      return messages
        .filter(
          (message) =>
            message.messageSeq > liveMessageFloor && !handledMessageIds.has(message.messageId)
        )
        .map((message) => ({
          message,
          frame: projectCollaborationMessage(message, sessionRefValue, memberRef),
        }))
    }

    const processLiveEvent = async (event: HrcLifecycleEvent): Promise<void> => {
      const frame = raw ? projectFrame(event) : projectPrimaryEvent(event)
      if (raw || frame?.frameKind !== 'user_prompt') {
        if (activeTimelineProjector !== undefined && timelineIdentity !== undefined) {
          sendAtoms(await activeTimelineProjector.admitLiveHrc(timelineIdentity, event))
        }
        sendFrame(frame)
        if (raw) sendMobileJsonEnvelope(ws, projectEvent(event))
        return
      }

      await queueLiveMerge(async () => {
        const candidatesById = new Map<string, ProjectedCollaborationFrame>()
        for (const pending of pendingCollaborations.values()) {
          candidatesById.set(pending.message.messageId, pending)
        }
        for (const collaboration of await recentLiveCollaborations()) {
          candidatesById.set(collaboration.message.messageId, collaboration)
        }
        const match = closestCollaborationMatch(frame, [...candidatesById.values()])
        if (match === undefined) {
          if (activeTimelineProjector !== undefined && timelineIdentity !== undefined) {
            sendAtoms(await activeTimelineProjector.admitLiveHrc(timelineIdentity, event))
          }
          sendFrame(frame)
          return
        }
        clearPendingCollaboration(match.message.messageId)
        handledMessageIds.add(match.message.messageId)
        if (activeTimelineProjector !== undefined && timelineIdentity !== undefined) {
          await activeTimelineProjector.admitLiveCollaboration(timelineIdentity, match.message, {
            suppressAtom: true,
          })
          sendAtoms(
            await activeTimelineProjector.admitLiveHrc(timelineIdentity, event, match.message)
          )
        }
        sendFrame(mergeCollaborationIdentity(frame, match))
      })
    }

    const processLiveMessage = async (message: CollaborationMessage): Promise<void> => {
      if (sessionRefValue === undefined || memberRef === undefined) return
      await queueLiveMerge(async () => {
        if (handledMessageIds.has(message.messageId)) return
        const frame = projectCollaborationMessage(message, sessionRefValue, memberRef)
        if (raw || frame.frameKind !== 'user_prompt') {
          handledMessageIds.add(message.messageId)
          if (activeTimelineProjector !== undefined && timelineIdentity !== undefined) {
            sendAtoms(
              await activeTimelineProjector.admitLiveCollaboration(timelineIdentity, message)
            )
          }
          sendFrame(frame)
          return
        }
        const timer = setTimeout(() => {
          void queueLiveMerge(() => flushPendingCollaboration(message.messageId))
        }, MOBILE_COLLABORATION_MATCH_WINDOW_MS)
        pendingCollaborations.set(message.messageId, { frame, message, timer })
      })
    }

    abortController.signal.addEventListener(
      'abort',
      () => {
        for (const pending of pendingCollaborations.values()) clearTimeout(pending.timer)
        pendingCollaborations.clear()
      },
      { once: true }
    )

    const pumpEvents = async (): Promise<void> => {
      if (timelineIdentity === undefined || timelineHrcLedgerIncarnationId === undefined) return
      const lane = splitSessionRef(timelineIdentity.sessionRef)
      for await (const streamed of hrcClient.watchBoundedEvents({
        ledgerIncarnationId: timelineHrcLedgerIncarnationId,
        afterSeq: options.fromSeq ?? 0,
        scopeRef: lane.scopeRef,
        laneRef: lane.laneRef,
        hostSessionId: timelineIdentity.hostSessionId,
        generation: timelineIdentity.generation,
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted) break
        const record = streamed as RelayedBoundedEventRecord
        if (record.type === 'home_unreachable') {
          // T-10418 §5.6: the home relay ended; the client reconnects from its cursor.
          sendMobileJsonEnvelope(ws, {
            type: 'error',
            code: 'session_home_unreachable',
            message: `session home ${record.homeNodeId} is unreachable (${record.reason}); reconnect`,
            retryable: true,
          })
          ws.close(1013, 'session home unreachable')
          return
        }
        if (record.type === 'ready') continue
        if (record.type === 'ledger_replaced') {
          sendMobileErrorEnvelope(
            ws,
            'cursor_invalid',
            'HRC event ledger incarnation changed; reopen the timeline'
          )
          ws.close(1012, 'timeline epoch replaced')
          return
        }
        if (record.type === 'gap') {
          sendMobileErrorEnvelope(
            ws,
            'timeline_reset_required',
            `HRC bounded delivery reported ${record.reason}; reopen the timeline`
          )
          ws.close(1012, 'timeline reset required')
          return
        }
        await processLiveEvent(record.event)
      }
      if (abortController.signal.aborted) return
      // The HRC stream ended without our abort (e.g. HRC restarted). The message
      // poll would keep the socket open and silent; close it so the client
      // reconnects from its cursor.
      sendMobileJsonEnvelope(ws, {
        type: 'error',
        code: 'timeline_stream_ended',
        message: 'HRC event stream ended; reconnect',
        retryable: true,
      })
      ws.close(1012, 'timeline stream ended')
      abortController.abort()
    }

    const pumpMessages = async (): Promise<void> => {
      if (memberRef === undefined || deps.collaborationLedger === undefined) return
      let afterMessageSeq = Number.isFinite(fromMessageSeq) ? fromMessageSeq : 0
      let expectedLedgerIncarnationId: string | undefined
      const waker = deps.commitWaker
      if (waker === undefined) throw new Error('wrkq commit waker is not configured')
      while (!abortController.signal.aborted) {
        const token = await waker.token()
        const page = await deps.collaborationLedger.pageMessagesByMember({
          memberRef,
          afterMessageSeq,
          ...(expectedLedgerIncarnationId !== undefined ? { expectedLedgerIncarnationId } : {}),
          limit: 500,
        })
        expectedLedgerIncarnationId = page.ledgerIncarnationId
        for (const message of page.messages) {
          if (abortController.signal.aborted) return
          await processLiveMessage(message)
          afterMessageSeq = message.messageSeq
        }
        if (page.hasMoreAfter) continue
        await waker.wait(token, { signal: abortController.signal })
      }
    }

    await Promise.all([pumpEvents(), pumpMessages()])
  } catch (error) {
    if (!abortController.signal.aborted) {
      sendMobileErrorEnvelope(
        ws,
        'mobile_stream_failed',
        error instanceof Error ? error.message : String(error)
      )
      // T-10837: a failed stream must not stay open and silent.
      ws.close(1011, 'mobile stream failed')
    }
  }
}
