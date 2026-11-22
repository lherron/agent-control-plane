/**
 * T-07724 covers production-wire mobile timeline ordering in one drive over
 * real HTTP and WebSocket with isolated HRC, wrkq, and ACP. It runs in the
 * default gate or on its own with `bun run test:acceptance` from the repo root.
 * See timeline-stack.ts for the native substrate and bearer setup.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  BULK_EVENT_COUNT,
  DECOY_HOST_SESSION_ID,
  DECOY_MEMBER_HANDLE,
  DECOY_SCOPE_REF,
  type HrcSeedSpec,
  TIMELINE_GENERATION,
  TIMELINE_HOST_SESSION_ID,
  TIMELINE_LANE_REF,
  TIMELINE_MEMBER_HANDLE,
  TIMELINE_SCOPE_REF,
  TIMELINE_SENDER_HANDLE,
  TIMELINE_SENDER_PRINCIPAL,
  buildDecoySpecs,
  buildTargetHistorySpecs,
  hrcAtomId,
  projectableHrcAtomIds,
  spliceStreams,
  wrkqAtomId,
} from './fixtures/timeline-fixture.js'
import {
  type TimelineStack,
  appendHrcHistory,
  createLiveHrcDriver,
  createTimelineStack,
  historyUrl,
  insertHrcSession,
  readCollaborationLedger,
  seedCollaborationEnvelopes,
} from './fixtures/timeline-stack.js'

import { type TimelineEvidence, createTimelineEvidence } from './fixtures/timeline-evidence.js'
import {
  HISTORY_PAGE_LIMIT,
  TIMELINE_TARGET,
  checkLedgerReplacement,
  checkTimelineHistory,
} from './fixtures/timeline-history-contract.js'
import { checkLiveTimeline, checkRotatedGeneration } from './fixtures/timeline-live-contract.js'

const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')
const REPORT_PATH =
  process.env['ACP_TIMELINE_E2E_REPORT'] ??
  join(REPO_ROOT, 'var/e2e-reports/mobile-timeline-ordering.json')

const COLLABORATION_BATCHES = 7
const COLLABORATION_PER_BATCH = 90

const DECOY_SENDER_PRINCIPAL = 'agent:tldecoysender'

let stack: TimelineStack | undefined
let evidence: TimelineEvidence | undefined
let driveError: unknown

describe('T-07724 production-wire mobile timeline ordering', () => {
  test('drives snapshot, live catch-up, and older paging over the production wire', async () => {
    const started = new Date().toISOString()
    const current = await createTimelineStack()
    stack = current

    const report: TimelineEvidence = createTimelineEvidence(started, current)
    evidence = report
    const phaseClock = { at: Date.now() }
    const mark = (name: string): void => {
      const nowMs = Date.now()
      report.phaseMs[name] = nowMs - phaseClock.at
      phaseClock.at = nowMs
    }

    try {
      const now = new Date().toISOString()
      for (const [hostSessionId, scopeRef] of [
        [TIMELINE_HOST_SESSION_ID, TIMELINE_SCOPE_REF],
        [DECOY_HOST_SESSION_ID, DECOY_SCOPE_REF],
      ] as const) {
        insertHrcSession(current, {
          hostSessionId,
          scopeRef,
          laneRef: TIMELINE_LANE_REF,
          generation: TIMELINE_GENERATION,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
      }

      // Collaboration history spans multiple producer pages.
      for (let batch = 0; batch < COLLABORATION_BATCHES; batch += 1) {
        await seedCollaborationEnvelopes(current, {
          speakerHandle: TIMELINE_SENDER_HANDLE,
          speakerPrincipalRef: TIMELINE_SENDER_PRINCIPAL,
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

      // Splice decoys into the selected generation’s history.
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
      await current.start()
      const driver = await createLiveHrcDriver(current, TIMELINE_HOST_SESSION_ID)
      const decoyDriver = await createLiveHrcDriver(current, DECOY_HOST_SESSION_ID)
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
      expectedHrcAtomIds.push(...projectableHrcAtomIds(hrcIncarnation, driver.warmup))
      const expectedWrkqAtomIds = ledger.envelopes.map((envelope) =>
        wrkqAtomId(ledger.ledgerIncarnation, envelope.messageId, envelope.messageSeq)
      )
      report.seeded.hrcProjectableExactGeneration = expectedHrcAtomIds.length
      report.oracle.expectedHrcAtoms = expectedHrcAtomIds.length
      report.oracle.expectedWrkqAtoms = expectedWrkqAtomIds.length

      const frameSeqByLabel = new Map(seededTarget.map((entry) => [entry.spec.label, entry.hrcSeq]))

      const url = historyUrl(current, TIMELINE_TARGET)
      const unauthenticated = await fetch(url)
      report.transport.unauthenticatedStatus = unauthenticated.status
      await unauthenticated.body?.cancel()
      const wrongToken = await fetch(url, { headers: { authorization: 'Bearer not-a-real-token' } })
      report.transport.wrongTokenStatus = wrongToken.status
      await wrongToken.body?.cancel()

      const live = await checkLiveTimeline(current, report, driver, decoyDriver, mark)
      const liveCursor = await checkTimelineHistory(
        current,
        report,
        driver,
        { ...live, expectedHrcAtomIds, expectedWrkqAtomIds, frameSeqByLabel },
        mark
      )

      await checkRotatedGeneration(current, report, driver)

      // Producer ledger replacement is destructive to this scratch stack and runs last.
      await checkLedgerReplacement(current, report, liveCursor)
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

  const evidenceOrThrow = (): TimelineEvidence => {
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
    expect(report.gates['live_rotated_generation_isolation']?.ok).toBe(true)
  })

  test('non-contiguous contributions to one response stay independently ordered', () => {
    const report = evidenceOrThrow()
    expect(report.gates['non_contiguous_logical_frame']?.ok).toBe(true)
    expect(report.gates['chunked_response_complete']?.ok).toBe(true)
  })

  test('live bursts and snapshot-race arrivals drain completely and exactly once', () => {
    const report = evidenceOrThrow()
    expect(report.gates['live_burst_drained']?.ok).toBe(true)
    expect(report.gates['live_hrc_exactly_once_ordered']?.ok).toBe(true)
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
