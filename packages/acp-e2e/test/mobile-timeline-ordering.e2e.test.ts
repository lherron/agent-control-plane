/**
 * T-07724 — production-wire ordering acceptance gate for the P-00454 mobile
 * timeline.
 *
 * This suite drives the composed contract end to end through the seams a real
 * HRCMac client uses: an isolated real HRC daemon, an isolated real wrkq store,
 * the production `acp-server` process over real HTTP and WebSocket, and the
 * production bearer gate. Nothing here substitutes a hand-written producer or
 * projector double.
 *
 * The whole drive runs once (it is expensive: >10,000 HRC records, >1,000
 * collaboration envelopes, and a full paging walk), records inspectable
 * evidence, and every gate below asserts against that recorded evidence.
 *
 * OPT-IN. This is an acceptance gate, not a unit suite: it spawns a real HRC
 * daemon, a real `wrkf` RPC process and the production `acp-server`, binds an
 * ephemeral port on a non-loopback interface, and needs the `wrkf`/`wrkqadm`
 * binaries on PATH. Run it with:
 *
 *     bun run test:acceptance            # from the repository root
 *
 * It is deliberately out of the default `bun run test` gate until the campaign
 * closes the defect it currently reports (see the run's JSON evidence report
 * and the `exactly_once_no_gaps` finding); promoting it into the default gate
 * is the campaign's call, not this suite's.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  BULK_EVENT_COUNT,
  CHUNK_COUNT,
  CHUNK_RUN_ID,
  DECOY_HOST_SESSION_ID,
  DECOY_MEMBER_HANDLE,
  DECOY_SCOPE_REF,
  type HrcSeedSpec,
  type OracleAtom,
  type OracleFinding,
  SIBLING_GENERATION,
  TIMELINE_GENERATION,
  TIMELINE_HOST_SESSION_ID,
  TIMELINE_LANE_REF,
  TIMELINE_MEMBER_HANDLE,
  TIMELINE_SCOPE_REF,
  TIMELINE_SENDER_HANDLE,
  TIMELINE_SESSION_REF,
  buildDecoySpecs,
  buildTargetHistorySpecs,
  checkOrdinalMonotonicity,
  checkSourceSequencePreserved,
  compareIdentitySets,
  hrcAtomId,
  spliceStreams,
  wrkqAtomId,
} from './fixtures/timeline-fixture.js'
import {
  type HistoryPageWire,
  type MobileTimelineAtomWire,
  type TimelineStack,
  appendHrcHistory,
  authorizedHeaders,
  createLiveHrcIngest,
  createTimelineStack,
  historyUrl,
  insertHrcSession,
  readCollaborationLedger,
  readHistory,
  replaceCollaborationLedgerIncarnation,
  replaceHrcLedgerIncarnation,
  seedCollaborationEnvelopes,
} from './fixtures/timeline-stack.js'

const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')
const REPORT_PATH =
  process.env['ACP_TIMELINE_E2E_REPORT'] ??
  join(REPO_ROOT, 'var/e2e-reports/mobile-timeline-ordering.json')

const HISTORY_PAGE_LIMIT = 100
const MAX_HISTORY_PAGES = 600
const COLLABORATION_BATCHES = 7
const COLLABORATION_PER_BATCH = 90
const LIVE_HRC_BURST = 120
const LIVE_WRKQ_BURST = 560
const SNAPSHOT_RACE_WRKQ = 12
const MID_WALK_WRKQ = 24
const MID_WALK_HRC = 24

const SENDER_PRINCIPAL = 'agent:tlsender'
const MEMBER_PRINCIPAL = 'agent:tlagent'
const DECOY_SENDER_PRINCIPAL = 'agent:tldecoysender'
const PEER_HANDLE = 'tlpeer@tlproj'

type PageEvidence = {
  index: number
  /** Decoded cursor fence, so the walk is inspectable without opaque blobs. */
  cursorFence: {
    projectionEpoch: string
    beforeTimelineOrdinal: string
    beforeHrcSeq: number
    beforeMessageSeq: number
  }
  status: number
  encodedBytes: number
  atomCount: number
  firstOrdinal: string | null
  lastOrdinal: string | null
  olderCursor: string | null
  hasMoreBefore: boolean
}

type Evidence = {
  startedAt: string
  finishedAt?: string
  identity: {
    sessionRef: string
    hostSessionId: string
    generation: number
    memberRef: string
    hrcLedgerIncarnationId: string
    wrkqLedgerIncarnation: string
    projectionEpoch: string
  }
  transport: {
    apiBase: string
    loopbackBase: string
    bearerEnforcedOnApiBase: boolean
    unauthenticatedStatus: number | null
    wrongTokenStatus: number | null
  }
  seeded: {
    hrcRecordsTotal: number
    hrcRecordsExactGeneration: number
    hrcDecoyRecords: number
    hrcProjectableExactGeneration: number
    collaborationEnvelopes: number
    collaborationDistinctSeconds: number
    chunkedResponseAtoms: number
    liveHrcInjected: number
    liveWrkqInjected: number
  }
  boundedReads: {
    historyRequests: number
    historyPages: PageEvidence[]
    totalHistoryAtoms: number
    totalHistoryBytes: number
    maxPageBytes: number
    maxPageAtoms: number
  }
  snapshot: {
    envelopeCount: number
    atomCount: number
    highWater: { hrcSeq: number; messageSeq: number }
    olderCursor: string | null
    replayAfterSnapshot: number
  }
  live: {
    atomsDelivered: number
    duplicateAtomIds: string[]
    dedupSuppressedEnvelopeId: string | null
    dedupCarrierAtomId: string | null
  }
  oracle: {
    expectedHrcAtoms: number
    expectedWrkqAtoms: number
    observedAtoms: number
    findings: OracleFinding[]
  }
  negatives: Record<string, { status: number; code?: string | undefined; atoms: number }>
  gates: Record<string, { ok: boolean; detail: string }>
  phaseMs: Record<string, number>
  notes: string[]
}

let stack: TimelineStack | undefined
let evidence: Evidence | undefined
let driveError: unknown

// ── Helpers ─────────────────────────────────────────────────────────────────

function toOracleAtom(atom: MobileTimelineAtomWire): OracleAtom {
  return {
    atomId: atom.atomId,
    sourceKind: atom.sourceKind,
    sourceSeq: atom.sourceSeq,
    timelineOrdinal: BigInt(atom.timelineOrdinal),
    logicalFrameId: atom.logicalFrameId,
    operation: atom.operation,
  }
}

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

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

// ── The single production-wire drive ────────────────────────────────────────

const ACCEPTANCE_ENABLED = process.env['ACP_TIMELINE_ACCEPTANCE'] === '1'

describe.skipIf(!ACCEPTANCE_ENABLED)('T-07724 production-wire mobile timeline ordering', () => {
  test('drives snapshot, live catch-up, and older paging over the production wire', async () => {
    const started = new Date().toISOString()
    const current = await createTimelineStack()
    stack = current

    const report: Evidence = {
      startedAt: started,
      identity: {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
        memberRef: TIMELINE_MEMBER_HANDLE,
        hrcLedgerIncarnationId: '',
        wrkqLedgerIncarnation: '',
        projectionEpoch: '',
      },
      transport: {
        apiBase: current.apiBase,
        loopbackBase: current.loopbackBase,
        bearerEnforcedOnApiBase: current.bearerEnforcedOnApiBase,
        unauthenticatedStatus: null,
        wrongTokenStatus: null,
      },
      seeded: {
        hrcRecordsTotal: 0,
        hrcRecordsExactGeneration: 0,
        hrcDecoyRecords: 0,
        hrcProjectableExactGeneration: 0,
        collaborationEnvelopes: 0,
        collaborationDistinctSeconds: 0,
        chunkedResponseAtoms: CHUNK_COUNT,
        liveHrcInjected: 0,
        liveWrkqInjected: 0,
      },
      boundedReads: {
        historyRequests: 0,
        historyPages: [],
        totalHistoryAtoms: 0,
        totalHistoryBytes: 0,
        maxPageBytes: 0,
        maxPageAtoms: 0,
      },
      snapshot: {
        envelopeCount: 0,
        atomCount: 0,
        highWater: { hrcSeq: 0, messageSeq: 0 },
        olderCursor: null,
        replayAfterSnapshot: 0,
      },
      live: {
        atomsDelivered: 0,
        duplicateAtomIds: [],
        dedupSuppressedEnvelopeId: null,
        dedupCarrierAtomId: null,
      },
      oracle: {
        expectedHrcAtoms: 0,
        expectedWrkqAtoms: 0,
        observedAtoms: 0,
        findings: [],
      },
      negatives: {},
      gates: {},
      phaseMs: {},
      notes: [
        'Inbound collaboration envelopes are held by the live seam for the 120s collaboration match window before admission; the snapshot-race and live-burst gates therefore use envelopes spoken by the session scope, and the inbound path is gated through the dedup carrier instead.',
      ],
    }
    evidence = report
    const phaseClock = { at: Date.now() }
    const mark = (name: string): void => {
      const nowMs = Date.now()
      report.phaseMs[name] = nowMs - phaseClock.at
      phaseClock.at = nowMs
    }

    try {
      // ── 1. Sessions ────────────────────────────────────────────────────
      const now = new Date().toISOString()
      insertHrcSession(current, {
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        scopeRef: TIMELINE_SCOPE_REF,
        laneRef: TIMELINE_LANE_REF,
        generation: TIMELINE_GENERATION,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      insertHrcSession(current, {
        hostSessionId: DECOY_HOST_SESSION_ID,
        scopeRef: DECOY_SCOPE_REF,
        laneRef: TIMELINE_LANE_REF,
        generation: TIMELINE_GENERATION,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      // ── 2. Collaboration history (> one producer page) ──────────────────
      for (let batch = 0; batch < COLLABORATION_BATCHES; batch += 1) {
        await seedCollaborationEnvelopes(current, {
          speakerHandle: TIMELINE_SENDER_HANDLE,
          speakerPrincipalRef: SENDER_PRINCIPAL,
          addresseeHandle: TIMELINE_MEMBER_HANDLE,
          bodies: Array.from(
            { length: COLLABORATION_PER_BATCH },
            (_unused, index) => `collaboration batch ${batch} item ${index}`
          ),
        })
        // A deliberately similar-looking foreign member, minted in the same
        // ledger: its envelopes must never enter the selected timeline.
        await seedCollaborationEnvelopes(current, {
          speakerHandle: 'tldecoysender@tlproj',
          speakerPrincipalRef: DECOY_SENDER_PRINCIPAL,
          addresseeHandle: DECOY_MEMBER_HANDLE,
          bodies: [`collaboration batch ${batch} item 0`, `collaboration batch ${batch} item 1`],
        })
        if (batch < COLLABORATION_BATCHES - 1) await Bun.sleep(1_100)
      }

      mark('seed_collaboration')
      const ledger = await readCollaborationLedger(current, TIMELINE_MEMBER_HANDLE)
      report.identity.wrkqLedgerIncarnation = ledger.ledgerIncarnation
      report.seeded.collaborationEnvelopes = ledger.envelopes.length
      const collaborationSeconds = [
        ...new Set(ledger.envelopes.map((envelope) => envelope.createdAt)),
      ].sort()
      report.seeded.collaborationDistinctSeconds = collaborationSeconds.length

      // ── 3. HRC history: exact generation + spliced decoys ───────────────
      const anchorMs = Date.parse(collaborationSeconds[0] as string)
      const targetSpecs = buildTargetHistorySpecs({ anchorMs, collaborationSeconds })
      const decoySpecs = buildDecoySpecs({ anchorMs, count: 600 })
      const { combined, targetIndices } = spliceStreams(targetSpecs, decoySpecs)
      const appended = appendHrcHistory(
        current,
        combined.map((spec) => spec.event)
      )
      report.seeded.hrcRecordsTotal = appended.length
      report.seeded.hrcRecordsExactGeneration = targetSpecs.length
      report.seeded.hrcDecoyRecords = decoySpecs.length

      const seededTarget = targetSpecs.map((spec: HrcSeedSpec, index: number) => ({
        spec,
        hrcSeq: (appended[targetIndices[index] as number] as { hrcSeq: number }).hrcSeq,
      }))

      mark('seed_hrc_history')
      const head = await current.hrc.client.tailEvents({
        limit: 1,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
      })
      const hrcIncarnation = head.ledgerIncarnationId
      report.identity.hrcLedgerIncarnationId = hrcIncarnation

      const expectedHrcAtomIds = seededTarget
        .filter((entry) => entry.spec.projects)
        .map((entry) => hrcAtomId(hrcIncarnation, entry.hrcSeq))
      const expectedWrkqAtomIds = ledger.envelopes.map((envelope) =>
        wrkqAtomId(ledger.ledgerIncarnation, envelope.messageId, envelope.messageSeq)
      )
      report.seeded.hrcProjectableExactGeneration = expectedHrcAtomIds.length
      report.oracle.expectedHrcAtoms = expectedHrcAtomIds.length
      report.oracle.expectedWrkqAtoms = expectedWrkqAtomIds.length

      const frameSeqByLabel = new Map(seededTarget.map((entry) => [entry.spec.label, entry.hrcSeq]))

      // ── 4. Transport gates on the production wire ──────────────────────
      const unauthenticated = await fetch(
        historyUrl(current, {
          sessionRef: TIMELINE_SESSION_REF,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          generation: TIMELINE_GENERATION,
        })
      )
      report.transport.unauthenticatedStatus = unauthenticated.status
      await unauthenticated.body?.cancel()
      const wrongToken = await fetch(
        historyUrl(current, {
          sessionRef: TIMELINE_SESSION_REF,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          generation: TIMELINE_GENERATION,
        }),
        { headers: { authorization: 'Bearer not-a-real-token' } }
      )
      report.transport.wrongTokenStatus = wrongToken.status
      await wrongToken.body?.cancel()

      // ── 5. Snapshot, with arrivals racing the snapshot read ────────────
      const ingest = createLiveHrcIngest(current, 'acp-timeline-e2e-live')
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
        speakerPrincipalRef: MEMBER_PRINCIPAL,
        addresseeHandle: PEER_HANDLE,
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

      // ── 6. Live phase ──────────────────────────────────────────────────
      // 6a. One inbound envelope that a live HRC user prompt will claim: the
      //     dedup contract says the envelope must not mint its own atom.
      const dedupBody = `live dedup carrier ${Date.now()}`
      const [dedupEnvelope] = await seedCollaborationEnvelopes(current, {
        speakerHandle: TIMELINE_SENDER_HANDLE,
        speakerPrincipalRef: SENDER_PRINCIPAL,
        addresseeHandle: TIMELINE_MEMBER_HANDLE,
        bodies: [dedupBody],
      })
      report.live.dedupSuppressedEnvelopeId = dedupEnvelope?.messageId ?? null
      await Bun.sleep(1_500)
      await ingest.post([
        {
          ts: new Date().toISOString(),
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          scopeRef: TIMELINE_SCOPE_REF,
          laneRef: TIMELINE_LANE_REF,
          generation: TIMELINE_GENERATION,
          runId: 'run-live',
          category: 'turn',
          eventKind: 'turn.user_prompt',
          payload: { text: dedupBody },
        },
      ])
      report.seeded.liveHrcInjected += 1

      // 6b. A live HRC burst larger than one snapshot page.
      const liveHrcEvents = Array.from({ length: LIVE_HRC_BURST }, (_unused, index) => ({
        ts: new Date(Date.now() + index).toISOString(),
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        scopeRef: TIMELINE_SCOPE_REF,
        laneRef: TIMELINE_LANE_REF,
        generation: TIMELINE_GENERATION,
        runId: 'run-live',
        category: 'turn' as const,
        eventKind: index % 4 === 3 ? 'turn.completed' : 'turn.message',
        payload: index % 4 === 3 ? { ok: true } : { text: `live assistant message ${index}` },
      }))
      // Decoy live arrivals on the sibling generation and the foreign session.
      const liveDecoyEvents = Array.from({ length: 40 }, (_unused, index) => ({
        ts: new Date(Date.now() + index).toISOString(),
        hostSessionId: index % 2 === 0 ? TIMELINE_HOST_SESSION_ID : DECOY_HOST_SESSION_ID,
        scopeRef: index % 2 === 0 ? TIMELINE_SCOPE_REF : DECOY_SCOPE_REF,
        laneRef: TIMELINE_LANE_REF,
        generation: index % 2 === 0 ? SIBLING_GENERATION : TIMELINE_GENERATION,
        runId: 'run-live-decoy',
        category: 'turn' as const,
        eventKind: 'turn.message',
        payload: { text: `live assistant message ${index}` },
      }))
      await ingest.post([...liveHrcEvents, ...liveDecoyEvents])
      report.seeded.liveHrcInjected += liveHrcEvents.length

      // 6c. A live collaboration burst larger than one wrkq producer page.
      const liveWrkq = await seedCollaborationEnvelopes(current, {
        speakerHandle: TIMELINE_MEMBER_HANDLE,
        speakerPrincipalRef: MEMBER_PRINCIPAL,
        addresseeHandle: PEER_HANDLE,
        bodies: Array.from(
          { length: LIVE_WRKQ_BURST },
          (_unused, index) => `live outbound message ${index}`
        ),
      })
      report.seeded.liveWrkqInjected = liveWrkq.length

      const liveHrcExpected = new Set(
        Array.from({ length: LIVE_HRC_BURST }, (_unused, index) => index)
          .filter((index) => index % 4 !== 3)
          .map((index) => `live assistant message ${index}`)
      )
      const liveWrkqExpectedIds = new Set(liveWrkq.map((envelope) => envelope.messageId))
      const drained = await socket.waitFor(() => {
        const wrkqSeen = new Set(
          socket.atoms
            .filter((atom) => atom.sourceKind === 'wrkq')
            .map((atom) => atom.atomId.split(':')[2] as string)
        )
        let hrcSeen = 0
        for (const atom of socket.atoms) {
          if (atom.sourceKind !== 'hrc') continue
          hrcSeen += 1
        }
        return (
          hrcSeen >= liveHrcExpected.size &&
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
              atom.sourceKind === 'wrkq' && atom.atomId.includes(dedupEnvelope?.messageId ?? ' ')
          ),
        detail: `carrier=${dedupCarrier?.atomId ?? 'none'} suppressed=${dedupEnvelope?.messageId ?? 'none'}`,
      }

      socket.close()

      // Everything injected during or after the snapshot must be delivered
      // exactly once across snapshot ∪ live.
      const racedIds = raced.map((envelope) =>
        wrkqAtomId(ledger.ledgerIncarnation, envelope.messageId, envelope.messageSeq)
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

      // ── 7. Older paging to exhaustion, with arrivals mid-walk ──────────
      const walked: MobileTimelineAtomWire[] = []
      const pageAtomsByCursor = new Map<string, MobileTimelineAtomWire[]>()
      const walkCursors: string[] = []
      let cursor = history.olderCursor
      let pageIndex = 0
      let injectedMidWalk = false
      const midWalkWrkqIds: string[] = []
      const midWalkHrcTexts: string[] = []

      while (cursor !== null && pageIndex < MAX_HISTORY_PAGES) {
        const response = await readHistory(current, {
          sessionRef: TIMELINE_SESSION_REF,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          generation: TIMELINE_GENERATION,
          limit: HISTORY_PAGE_LIMIT,
          cursor,
        })
        report.boundedReads.historyRequests += 1
        const atoms = response.body.atoms ?? []
        const fence = decodeCursor(cursor)
        report.boundedReads.historyPages.push({
          index: pageIndex,
          cursorFence: {
            projectionEpoch: String(fence['projectionEpoch']),
            beforeTimelineOrdinal: String(fence['beforeTimelineOrdinal']),
            beforeHrcSeq: Number(fence['beforeHrcSeq']),
            beforeMessageSeq: Number(fence['beforeMessageSeq']),
          },
          status: response.status,
          encodedBytes: response.bytes,
          atomCount: atoms.length,
          firstOrdinal: atoms[0]?.timelineOrdinal ?? null,
          lastOrdinal: atoms.at(-1)?.timelineOrdinal ?? null,
          olderCursor: response.body.olderCursor,
          hasMoreBefore: response.body.hasMoreBefore,
        })
        report.boundedReads.totalHistoryAtoms += atoms.length
        report.boundedReads.totalHistoryBytes += response.bytes
        report.boundedReads.maxPageBytes = Math.max(
          report.boundedReads.maxPageBytes,
          response.bytes
        )
        report.boundedReads.maxPageAtoms = Math.max(report.boundedReads.maxPageAtoms, atoms.length)
        if (response.status !== 200) {
          report.gates['older_paging_status'] = {
            ok: false,
            detail: `page ${pageIndex} returned ${response.status} ${response.body.code ?? ''}`,
          }
          break
        }
        pageAtomsByCursor.set(cursor, atoms)
        walkCursors.push(cursor)
        walked.unshift(...atoms)

        if (!injectedMidWalk && pageIndex === 2) {
          injectedMidWalk = true
          const midWrkq = await seedCollaborationEnvelopes(current, {
            speakerHandle: TIMELINE_SENDER_HANDLE,
            speakerPrincipalRef: SENDER_PRINCIPAL,
            addresseeHandle: TIMELINE_MEMBER_HANDLE,
            bodies: Array.from(
              { length: MID_WALK_WRKQ },
              (_unused, index) => `mid-walk envelope ${index}`
            ),
          })
          for (const envelope of midWrkq) midWalkWrkqIds.push(envelope.messageId)
          const midHrc = Array.from({ length: MID_WALK_HRC }, (_unused, index) => {
            const text = `mid-walk assistant message ${index}`
            midWalkHrcTexts.push(text)
            return {
              ts: new Date(Date.now() + index).toISOString(),
              hostSessionId: TIMELINE_HOST_SESSION_ID,
              scopeRef: TIMELINE_SCOPE_REF,
              laneRef: TIMELINE_LANE_REF,
              generation: TIMELINE_GENERATION,
              runId: 'run-mid-walk',
              category: 'turn' as const,
              eventKind: 'turn.message',
              payload: { text },
            }
          })
          await ingest.post(midHrc)
        }

        cursor = response.body.olderCursor
        pageIndex += 1
      }
      mark('older_paging')
      report.gates['older_paging_terminated'] = {
        ok: pageIndex < MAX_HISTORY_PAGES,
        detail: `walked ${pageIndex} older pages (cap ${MAX_HISTORY_PAGES})`,
      }

      // Full recent-first walk: everything below the snapshot, then the
      // snapshot itself, in ordinal order.
      const observed = [...walked, ...history.atoms]
      report.oracle.observedAtoms = observed.length

      const observedAtoms = observed.map(toOracleAtom)
      const findings: OracleFinding[] = [
        ...compareIdentitySets(
          'exactly_once_no_gaps',
          [...expectedHrcAtomIds, ...expectedWrkqAtomIds],
          observed
            .map((atom) => atom.atomId)
            // Arrivals injected during the walk legitimately sit above the
            // snapshot; they are gated separately and are not part of the
            // seeded historical identity set.
            .filter((id) => expectedHrcAtomIds.includes(id) || expectedWrkqAtomIds.includes(id))
        ),
        ...checkOrdinalMonotonicity('ordinal_monotonic', observedAtoms),
        ...checkSourceSequencePreserved('source_sequence_preserved', observedAtoms),
      ]
      report.oracle.findings = findings.slice(0, 24)

      const observedIds = new Set(observed.map((atom) => atom.atomId))
      const missingHrc = expectedHrcAtomIds.filter((id) => !observedIds.has(id))
      const missingWrkq = expectedWrkqAtomIds.filter((id) => !observedIds.has(id))
      report.gates['no_lost_prefix'] = {
        ok: missingHrc.length === 0 && missingWrkq.length === 0,
        detail: `missing hrc=${missingHrc.length} wrkq=${missingWrkq.length}`,
      }

      // Foreign identities must never appear.
      const foreign = observed.filter(
        (atom) =>
          !expectedHrcAtomIds.includes(atom.atomId) &&
          !expectedWrkqAtomIds.includes(atom.atomId) &&
          !midWalkWrkqIds.some((id) => atom.atomId.includes(id)) &&
          !midWalkHrcTexts.some((text) => JSON.stringify(atom.payload).includes(text)) &&
          !racedIds.includes(atom.atomId)
      )
      report.gates['exact_identity_isolation'] = {
        ok: foreign.length === 0,
        detail:
          foreign.length === 0
            ? 'no sibling-generation or foreign-session identity entered the timeline'
            : `foreign atoms: ${foreign
                .slice(0, 5)
                .map((atom) => atom.atomId)
                .join(', ')}`,
      }

      // Non-contiguous contributions to one logical response.
      const frameFirst = frameSeqByLabel.get('frame.assistant.first')
      const frameSecond = frameSeqByLabel.get('frame.assistant.second')
      const frameTool = frameSeqByLabel.get('frame.tool_call')
      const frameStatus = frameSeqByLabel.get('frame.status')
      const positionOf = (seq: number | undefined): number =>
        seq === undefined
          ? -1
          : observed.findIndex((atom) => atom.atomId === hrcAtomId(hrcIncarnation, seq))
      const firstPos = positionOf(frameFirst)
      const toolPos = positionOf(frameTool)
      const statusPos = positionOf(frameStatus)
      const secondPos = positionOf(frameSecond)
      const frameId = observed[firstPos]?.logicalFrameId
      report.gates['non_contiguous_logical_frame'] = {
        ok:
          firstPos >= 0 &&
          toolPos > firstPos &&
          statusPos > toolPos &&
          secondPos > statusPos &&
          frameId !== undefined &&
          observed[secondPos]?.logicalFrameId === frameId &&
          observed[toolPos]?.logicalFrameId !== frameId &&
          observed[statusPos]?.operation === 'replace',
        detail: `A1=${firstPos} tool=${toolPos} status=${statusPos} A2=${secondPos} frame=${frameId ?? 'none'} statusOp=${observed[statusPos]?.operation ?? 'none'}`,
      }

      // The 1,000-chunk response stays whole and in producer order.
      const chunkAtoms = observed.filter(
        (atom) => atom.logicalFrameId === `assistant:${CHUNK_RUN_ID}:${TIMELINE_GENERATION}`
      )
      report.gates['chunked_response_complete'] = {
        ok:
          chunkAtoms.length === CHUNK_COUNT &&
          chunkAtoms.every(
            (atom, index) => index === 0 || atom.sourceSeq > (chunkAtoms[index - 1]?.sourceSeq ?? 0)
          ),
        detail: `${chunkAtoms.length}/${CHUNK_COUNT} chunk atoms, producer order preserved`,
      }

      // ── 8. Page replay idempotence ─────────────────────────────────────
      const replayCursor = walkCursors[1]
      if (replayCursor !== undefined) {
        const first = await readHistory(current, {
          sessionRef: TIMELINE_SESSION_REF,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          generation: TIMELINE_GENERATION,
          limit: HISTORY_PAGE_LIMIT,
          cursor: replayCursor,
        })
        const second = await readHistory(current, {
          sessionRef: TIMELINE_SESSION_REF,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          generation: TIMELINE_GENERATION,
          limit: HISTORY_PAGE_LIMIT,
          cursor: replayCursor,
        })
        report.boundedReads.historyRequests += 2
        const original = pageAtomsByCursor.get(replayCursor) ?? []
        report.gates['page_replay_idempotent'] = {
          ok:
            JSON.stringify(first.body.atoms) === JSON.stringify(second.body.atoms) &&
            JSON.stringify(first.body.atoms) === JSON.stringify(original),
          detail: `replayed ${first.body.atoms?.length ?? 0} atoms; ordinals unchanged=${
            JSON.stringify(first.body.atoms?.map((atom) => atom.timelineOrdinal)) ===
            JSON.stringify(original.map((atom) => atom.timelineOrdinal))
          }`,
        }
      }

      // ── 9. Negative cursor gates ───────────────────────────────────────
      const liveCursor = walkCursors[0] ?? ''
      const negative = async (
        name: string,
        query: Parameters<typeof readHistory>[1]
      ): Promise<void> => {
        const response = await readHistory(current, query)
        report.boundedReads.historyRequests += 1
        report.negatives[name] = {
          status: response.status,
          code: response.body.code,
          atoms: response.body.atoms?.length ?? 0,
        }
      }

      await negative('malformed_cursor', {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
        cursor: '!!! not base64url !!!',
      })
      await negative('wrong_generation_cursor', {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: SIBLING_GENERATION,
        cursor: liveCursor,
      })
      await negative('wrong_session_cursor', {
        sessionRef: `${DECOY_SCOPE_REF}/lane:${TIMELINE_LANE_REF}`,
        hostSessionId: DECOY_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
        cursor: liveCursor,
      })
      if (liveCursor.length > 0) {
        const payload = decodeCursor(liveCursor)
        await negative('future_ordinal_cursor', {
          sessionRef: TIMELINE_SESSION_REF,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          generation: TIMELINE_GENERATION,
          cursor: encodeCursor({
            ...payload,
            beforeTimelineOrdinal: String(
              BigInt(payload['beforeTimelineOrdinal'] as string) + 1_000_000n
            ),
          }),
        })
        await negative('retired_producer_cursor_type', {
          sessionRef: TIMELINE_SESSION_REF,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          generation: TIMELINE_GENERATION,
          cursor: encodeCursor({ ...payload, type: 'mobile_live' }),
        })
      }
      await negative('raw_producer_cursor_retired', {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
        extra: { beforeHrcSeq: '10' },
      })

      // Sibling generation opens its own timeline and shares no identity.
      const siblingOpen = await readHistory(current, {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: SIBLING_GENERATION,
        limit: HISTORY_PAGE_LIMIT,
      })
      report.boundedReads.historyRequests += 1
      const siblingIds = new Set((siblingOpen.body.atoms ?? []).map((atom) => atom.atomId))
      report.gates['sibling_generation_disjoint'] = {
        ok:
          siblingOpen.status === 200 &&
          expectedHrcAtomIds.every((id) => !siblingIds.has(id)) &&
          expectedWrkqAtomIds.every((id) => !siblingIds.has(id)),
        detail: `sibling generation returned ${siblingIds.size} atoms, none shared with generation ${TIMELINE_GENERATION}`,
      }

      // ── 10. Producer ledger replacement (destructive; runs last) ───────
      replaceHrcLedgerIncarnation(current)
      const afterHrcReplacement = await readHistory(current, {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
        limit: HISTORY_PAGE_LIMIT,
      })
      report.boundedReads.historyRequests += 1
      report.gates['hrc_ledger_replacement_resets'] = {
        ok:
          afterHrcReplacement.status === 200 &&
          afterHrcReplacement.body.resetReason === 'producer_incarnation_changed',
        detail: `status=${afterHrcReplacement.status} resetReason=${afterHrcReplacement.body.resetReason ?? 'none'} epoch=${afterHrcReplacement.body.projectionEpoch}`,
      }
      await negative('cursor_after_hrc_ledger_replacement', {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
        cursor: liveCursor,
      })

      replaceCollaborationLedgerIncarnation(current)
      const afterWrkqReplacement = await readHistory(current, {
        sessionRef: TIMELINE_SESSION_REF,
        hostSessionId: TIMELINE_HOST_SESSION_ID,
        generation: TIMELINE_GENERATION,
        limit: HISTORY_PAGE_LIMIT,
      })
      report.boundedReads.historyRequests += 1
      report.gates['wrkq_ledger_replacement_resets'] = {
        ok:
          afterWrkqReplacement.status === 200 &&
          afterWrkqReplacement.body.resetReason === 'producer_incarnation_changed',
        detail: `status=${afterWrkqReplacement.status} resetReason=${afterWrkqReplacement.body.resetReason ?? 'none'}`,
      }
    } catch (error) {
      driveError = error
      throw error
    } finally {
      report.finishedAt = new Date().toISOString()
      mkdirSync(dirname(REPORT_PATH), { recursive: true })
      writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }

    expect(driveError).toBeUndefined()
  }, 900_000)

  afterAll(async () => {
    await stack?.close()
  })

  // ── Gates over the recorded evidence ──────────────────────────────────────

  const evidenceOrThrow = (): Evidence => {
    if (evidence === undefined) throw new Error('production-wire drive did not run')
    return evidence
  }

  test('fixture reaches the campaign record and page ceilings', () => {
    const report = evidenceOrThrow()
    expect(report.seeded.hrcRecordsExactGeneration).toBeGreaterThanOrEqual(10_000)
    expect(report.seeded.hrcRecordsTotal).toBeGreaterThan(report.seeded.hrcRecordsExactGeneration)
    expect(report.seeded.collaborationEnvelopes).toBeGreaterThan(500)
    expect(report.seeded.liveWrkqInjected).toBeGreaterThan(500)
    expect(report.seeded.chunkedResponseAtoms).toBeGreaterThanOrEqual(1_000)
    expect(BULK_EVENT_COUNT).toBeGreaterThan(0)
  })

  test('the production surface refuses unauthenticated and wrong-token callers', () => {
    const report = evidenceOrThrow()
    if (!report.transport.bearerEnforcedOnApiBase) {
      throw new Error(
        'no non-loopback IPv4 interface: the bearer gate cannot be exercised on this host'
      )
    }
    expect(report.transport.unauthenticatedStatus).toBe(401)
    expect(report.transport.wrongTokenStatus).toBe(401)
  })

  test('opening the timeline emits exactly one snapshot and no historical replay', () => {
    const report = evidenceOrThrow()
    expect(report.snapshot.envelopeCount).toBe(1)
    expect(report.snapshot.atomCount).toBeGreaterThan(0)
    expect(report.snapshot.replayAfterSnapshot).toBe(0)
  })

  test('older paging reaches exhaustion and returns a bounded page every time', () => {
    const report = evidenceOrThrow()
    expect(report.gates['older_paging_terminated']?.ok).toBe(true)
    expect(report.gates['older_paging_status']).toBeUndefined()
    expect(report.boundedReads.maxPageAtoms).toBeLessThanOrEqual(HISTORY_PAGE_LIMIT)
    expect(report.boundedReads.maxPageBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
  })

  test('every expected source contribution is delivered exactly once, in order', () => {
    const report = evidenceOrThrow()
    expect(report.oracle.findings).toEqual([])
    expect(report.gates['no_lost_prefix']?.ok).toBe(true)
  })

  test('sibling generations and foreign sessions never enter the timeline', () => {
    const report = evidenceOrThrow()
    expect(report.gates['exact_identity_isolation']?.ok).toBe(true)
    expect(report.gates['sibling_generation_disjoint']?.ok).toBe(true)
  })

  test('non-contiguous contributions to one response stay independently ordered', () => {
    const report = evidenceOrThrow()
    expect(report.gates['non_contiguous_logical_frame']?.ok).toBe(true)
    expect(report.gates['chunked_response_complete']?.ok).toBe(true)
  })

  test('live bursts and snapshot-race arrivals drain completely and exactly once', () => {
    const report = evidenceOrThrow()
    expect(report.gates['live_burst_drained']?.ok).toBe(true)
    expect(report.live.duplicateAtomIds).toEqual([])
    expect(report.gates['snapshot_race_exactly_once']?.ok).toBe(true)
    expect(report.gates['live_collaboration_dedup']?.ok).toBe(true)
  })

  test('repeating a delivered page is idempotent and never renumbers atoms', () => {
    const report = evidenceOrThrow()
    expect(report.gates['page_replay_idempotent']?.ok).toBe(true)
  })

  test('malformed, mistyped, foreign and future cursors are refused with no atoms', () => {
    const report = evidenceOrThrow()
    expect(report.negatives['malformed_cursor']).toMatchObject({ status: 400, atoms: 0 })
    expect(report.negatives['raw_producer_cursor_retired']).toMatchObject({ status: 400, atoms: 0 })
    for (const name of [
      'wrong_generation_cursor',
      'wrong_session_cursor',
      'future_ordinal_cursor',
      'retired_producer_cursor_type',
      'cursor_after_hrc_ledger_replacement',
    ]) {
      expect(report.negatives[name]).toMatchObject({ status: 409, atoms: 0 })
    }
  })

  test('a replaced producer ledger resets the projection instead of mixing epochs', () => {
    const report = evidenceOrThrow()
    expect(report.gates['hrc_ledger_replacement_resets']?.ok).toBe(true)
    expect(report.gates['wrkq_ledger_replacement_resets']?.ok).toBe(true)
  })

  test('the run persists inspectable evidence', () => {
    const report = evidenceOrThrow()
    expect(report.boundedReads.historyRequests).toBeGreaterThan(0)
    expect(report.identity.hrcLedgerIncarnationId.length).toBeGreaterThan(0)
    expect(report.identity.wrkqLedgerIncarnation.length).toBeGreaterThan(0)
    expect(report.identity.projectionEpoch.length).toBeGreaterThan(0)
  })
})
