import type { TimelineEvidence } from './timeline-evidence.js'
import {
  DECOY_SESSION_REF,
  type OracleFinding,
  TIMELINE_HOST_SESSION_ID,
  TIMELINE_MEMBER_HANDLE,
  TIMELINE_MEMBER_PRINCIPAL,
  TIMELINE_PEER_HANDLE,
  TIMELINE_SENDER_HANDLE,
  TIMELINE_SENDER_PRINCIPAL,
  TIMELINE_SESSION_REF,
  projectableHrcAtomIds,
  wrkqAtomId,
} from './timeline-fixture.js'
import { HISTORY_PAGE_LIMIT, TIMELINE_TARGET } from './timeline-history-contract.js'
import {
  type HistoryPageWire,
  type LiveHrcDriver,
  type MobileTimelineAtomWire,
  type TimelineStack,
  authorizedHeaders,
  createLiveHrcDriver,
  readHistory,
  seedCollaborationEnvelopes,
} from './timeline-stack.js'

const LIVE_HRC_BURST = 36
const LIVE_WRKQ_BURST = 560
const SNAPSHOT_RACE_WRKQ = 12

type TimelineSocket = {
  messages: Array<Record<string, unknown>>
  atoms: MobileTimelineAtomWire[]
  waitForSnapshot(timeoutMs: number): Promise<Record<string, unknown>>
  waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean>
  close(): void
}

function openTimelineSocket(current: TimelineStack, hostSessionId: string): TimelineSocket {
  const base = current.apiBase.replace(/^http/, 'ws')
  const socket = new WebSocket(`${base}/v1/mobile/sessions/${hostSessionId}/timeline`, {
    headers: authorizedHeaders(current),
  } as never)
  const messages: Array<Record<string, unknown>> = []
  const atoms: MobileTimelineAtomWire[] = []
  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : ''
    if (raw.length === 0) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    messages.push(parsed)
    if (
      parsed['type'] === 'atom' &&
      typeof parsed['atom'] === 'object' &&
      parsed['atom'] !== null
    ) {
      atoms.push(parsed['atom'] as MobileTimelineAtomWire)
    }
  })
  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await Bun.sleep(100)
    }
    return predicate()
  }
  return {
    messages,
    atoms,
    async waitForSnapshot(timeoutMs) {
      const found = await waitFor(
        () => messages.some((message) => message['type'] === 'snapshot'),
        timeoutMs
      )
      const snapshot = messages.find((message) => message['type'] === 'snapshot')
      if (!found || snapshot === undefined) {
        throw new Error(
          `timeline websocket produced no snapshot within ${timeoutMs}ms: ${JSON.stringify(messages).slice(0, 800)}`
        )
      }
      return snapshot
    },
    waitFor,
    close: () => socket.close(),
  }
}

export async function checkLiveTimeline(
  current: TimelineStack,
  report: TimelineEvidence,
  driver: LiveHrcDriver,
  decoyDriver: LiveHrcDriver,
  mark: (phase: string) => void
): Promise<{ history: Omit<HistoryPageWire, 'snapshotHighWater'>; racedIds: string[] }> {
  const hrcIncarnation = report.identity.hrcLedgerIncarnationId
  const socket = openTimelineSocket(current, TIMELINE_HOST_SESSION_ID)

  const raceBodies = Array.from(
    { length: SNAPSHOT_RACE_WRKQ },
    (_unused, index) => `snapshot race envelope ${index}`
  )
  // Spoken BY the session's own scope. Inbound envelopes are deliberately
  // parked by the live seam for the 120s collaboration match window before
  // they can be admitted, so an inbound race would measure that timer
  // rather than snapshot/live exactly-once delivery. The inbound path is
  // covered by the dedup gate below instead.
  const racedEnvelopes = seedCollaborationEnvelopes(current, {
    speakerHandle: TIMELINE_MEMBER_HANDLE,
    speakerPrincipalRef: TIMELINE_MEMBER_PRINCIPAL,
    addresseeHandle: TIMELINE_PEER_HANDLE,
    bodies: raceBodies,
  })

  mark('open_snapshot_request')
  const snapshot = await socket.waitForSnapshot(60_000)
  const raced = await racedEnvelopes
  // The WebSocket snapshot envelope carries the high-water; its embedded
  // `history` object carries the atoms, cursors and epoch.
  const history = snapshot['history'] as Omit<HistoryPageWire, 'snapshotHighWater'>
  const snapshotHighWater = snapshot['snapshotHighWater'] as {
    hrcSeq: number
    messageSeq: number
  }
  report.snapshot.envelopeCount = socket.messages.filter(
    (message) => message['type'] === 'snapshot'
  ).length
  report.snapshot.atomCount = history.atoms.length
  report.snapshot.highWater = snapshotHighWater
  report.snapshot.olderCursor = history.olderCursor
  report.identity.projectionEpoch = history.projectionEpoch

  // A live HRC user prompt claims one inbound envelope and suppresses its wrkq atom.
  const dedupBody = `live dedup carrier ${Date.now()}`
  const [dedupEnvelope] = await seedCollaborationEnvelopes(current, {
    speakerHandle: TIMELINE_SENDER_HANDLE,
    speakerPrincipalRef: TIMELINE_SENDER_PRINCIPAL,
    addresseeHandle: TIMELINE_MEMBER_HANDLE,
    bodies: [dedupBody],
  })
  report.live.dedupSuppressedEnvelopeId = dedupEnvelope?.messageId ?? null
  await Bun.sleep(1_500)
  const dedupEvents = await driver.submit(TIMELINE_SESSION_REF, dedupBody)
  const liveHrcExpectedIds = projectableHrcAtomIds(hrcIncarnation, dedupEvents)
  report.seeded.liveHrcInjected += dedupEvents.length

  // Real prompt admission and stub-broker completion on the same native
  // seat. The producer's run IDs and hrcSeq distinguish the fixed-text
  // assistant replies; neither text nor a test-generated ID is the oracle.
  for (let index = 0; index < LIVE_HRC_BURST; index++) {
    const events = await driver.submit(TIMELINE_SESSION_REF, `live prompt ${index}`)
    liveHrcExpectedIds.push(...projectableHrcAtomIds(hrcIncarnation, events))
    report.seeded.liveHrcInjected += events.length
  }
  const liveDecoyIds = new Set<string>()
  for (let index = 0; index < 6; index++) {
    const events = await decoyDriver.submit(DECOY_SESSION_REF, `foreign prompt ${index}`)
    for (const id of projectableHrcAtomIds(hrcIncarnation, events)) liveDecoyIds.add(id)
  }

  // A live collaboration burst larger than one wrkq producer page.
  const liveWrkq = await seedCollaborationEnvelopes(current, {
    speakerHandle: TIMELINE_MEMBER_HANDLE,
    speakerPrincipalRef: TIMELINE_MEMBER_PRINCIPAL,
    addresseeHandle: TIMELINE_PEER_HANDLE,
    bodies: Array.from(
      { length: LIVE_WRKQ_BURST },
      (_unused, index) => `live outbound message ${index}`
    ),
  })
  report.seeded.liveWrkqInjected = liveWrkq.length

  const liveWrkqExpectedIds = new Set(liveWrkq.map((envelope) => envelope.messageId))
  const drained = await socket.waitFor(() => {
    const wrkqSeen = new Set(
      socket.atoms
        .filter((atom) => atom.sourceKind === 'wrkq')
        .map((atom) => atom.atomId.split(':')[2] as string)
    )
    const hrcSeen = new Set(
      socket.atoms.filter((atom) => atom.sourceKind === 'hrc').map((atom) => atom.atomId)
    )
    return (
      liveHrcExpectedIds.every((id) => hrcSeen.has(id)) &&
      [...liveWrkqExpectedIds].every((id) => wrkqSeen.has(id))
    )
  }, 180_000)
  report.gates['live_burst_drained'] = {
    ok: drained,
    detail: drained
      ? 'live HRC and >500-envelope collaboration bursts drained inside the window'
      : 'live bursts did not drain within 180s',
  }

  mark('live_drain')
  const liveAtoms = [...socket.atoms]
  report.live.atomsDelivered = liveAtoms.length
  const observedLiveHrc = liveAtoms
    .filter((atom) => atom.sourceKind === 'hrc')
    .map((atom) => atom.atomId)
  report.gates['live_hrc_exactly_once_ordered'] = {
    ok:
      JSON.stringify(observedLiveHrc) === JSON.stringify(liveHrcExpectedIds) &&
      !liveAtoms.some((atom) => liveDecoyIds.has(atom.atomId)),
    detail: `${observedLiveHrc.length}/${liveHrcExpectedIds.length} canonical native HRC atoms, in producer order; foreign IDs excluded`,
  }
  const liveCounts = new Map<string, number>()
  for (const atom of liveAtoms) {
    liveCounts.set(atom.atomId, (liveCounts.get(atom.atomId) ?? 0) + 1)
  }
  report.live.duplicateAtomIds = [...liveCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .slice(0, 10)

  // No historical replay after the snapshot: every live atom must sit
  // strictly above the snapshot high-water for its own producer.
  report.snapshot.replayAfterSnapshot = liveAtoms.filter((atom) =>
    atom.sourceKind === 'hrc'
      ? atom.sourceSeq <= snapshotHighWater.hrcSeq
      : atom.sourceSeq <= snapshotHighWater.messageSeq
  ).length

  // The dedup carrier: the HRC user-prompt atom exists, the envelope's own
  // wrkq atom does not.
  const dedupCarrier = liveAtoms.find(
    (atom) =>
      atom.sourceKind === 'hrc' &&
      JSON.stringify(atom.payload).includes(dedupBody) &&
      !atom.atomId.startsWith('wrkq:')
  )
  report.live.dedupCarrierAtomId = dedupCarrier?.atomId ?? null
  report.gates['live_collaboration_dedup'] = {
    ok:
      dedupCarrier !== undefined &&
      !liveAtoms.some(
        (atom) =>
          atom.sourceKind === 'wrkq' && atom.atomId.includes(dedupEnvelope?.messageId ?? '\0')
      ),
    detail: `carrier=${dedupCarrier?.atomId ?? 'none'} suppressed=${dedupEnvelope?.messageId ?? 'none'}`,
  }

  socket.close()

  // Everything injected during or after the snapshot must be delivered
  // exactly once across snapshot ∪ live.
  const racedIds = raced.map((envelope) =>
    wrkqAtomId(report.identity.wrkqLedgerIncarnation, envelope.messageId, envelope.messageSeq)
  )
  const snapshotAndLive = [
    ...history.atoms.map((atom) => atom.atomId),
    ...liveAtoms.map((atom) => atom.atomId),
  ]
  const racedFindings = racedIds.flatMap((id) => {
    const count = snapshotAndLive.filter((candidate) => candidate === id).length
    return count === 1
      ? []
      : [
          {
            gate: 'snapshot_race_exactly_once',
            atomId: id,
            detail: `delivered ${count} times across snapshot and live`,
          } satisfies OracleFinding,
        ]
  })
  report.gates['snapshot_race_exactly_once'] = {
    ok: racedFindings.length === 0,
    detail:
      racedFindings.length === 0
        ? `${racedIds.length} arrivals racing the snapshot were each delivered exactly once`
        : JSON.stringify(racedFindings.slice(0, 4)),
  }

  return { history, racedIds }
}

export async function checkRotatedGeneration(
  current: TimelineStack,
  report: TimelineEvidence,
  driver: LiveHrcDriver
): Promise<void> {
  // A real rotation and successor runtime generate live events for another
  // generation of this exact scope. None may enter the old generation's
  // open stream or subsequent exact-generation history reads.
  const oldGenerationSocket = openTimelineSocket(current, TIMELINE_HOST_SESSION_ID)
  await oldGenerationSocket.waitForSnapshot(60_000)
  const rotated = await current.hrc.client.clearContext({
    hostSessionId: TIMELINE_HOST_SESSION_ID,
    relaunch: false,
  })
  current.runtimeIds.delete(driver.runtimeId) // clearContext already terminated this runtime
  const rotatedDriver = await createLiveHrcDriver(current, rotated.hostSessionId)
  const hrcIncarnation = report.identity.hrcLedgerIncarnationId
  const rotatedIds = new Set(projectableHrcAtomIds(hrcIncarnation, rotatedDriver.warmup))
  for (let index = 0; index < 3; index++) {
    for (const id of projectableHrcAtomIds(
      hrcIncarnation,
      await rotatedDriver.submit(TIMELINE_SESSION_REF, `rotated prompt ${index}`)
    ))
      rotatedIds.add(id)
  }
  await Bun.sleep(500)
  const oldGenerationHistory = await readHistory(current, {
    ...TIMELINE_TARGET,
    limit: HISTORY_PAGE_LIMIT,
  })
  report.gates['live_rotated_generation_isolation'] = {
    ok:
      oldGenerationHistory.status === 200 &&
      ![...oldGenerationSocket.atoms, ...oldGenerationHistory.body.atoms].some((atom) =>
        rotatedIds.has(atom.atomId)
      ),
    detail: `${rotatedIds.size} real successor-generation atoms excluded from the prior generation's stream and history`,
  }
  oldGenerationSocket.close()
}
