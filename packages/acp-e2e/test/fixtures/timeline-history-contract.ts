import type { TimelineEvidence } from './timeline-evidence.js'
import {
  CHUNK_COUNT,
  CHUNK_RUN_ID,
  DECOY_HOST_SESSION_ID,
  DECOY_SESSION_REF,
  type OracleAtom,
  SIBLING_GENERATION,
  TIMELINE_GENERATION,
  TIMELINE_HOST_SESSION_ID,
  TIMELINE_MEMBER_HANDLE,
  TIMELINE_SENDER_HANDLE,
  TIMELINE_SENDER_PRINCIPAL,
  TIMELINE_SESSION_REF,
  checkOrdinalMonotonicity,
  checkSourceSequencePreserved,
  compareIdentitySets,
  hrcAtomId,
  projectableHrcAtomIds,
} from './timeline-fixture.js'
import {
  type HistoryPageWire,
  type HistoryQuery,
  type LiveHrcDriver,
  type MobileTimelineAtomWire,
  type TimelineStack,
  readHistory,
  replaceCollaborationLedgerIncarnation,
  replaceHrcLedgerIncarnation,
  seedCollaborationEnvelopes,
} from './timeline-stack.js'

export const HISTORY_PAGE_LIMIT = 100
const MAX_HISTORY_PAGES = 600
const MID_WALK_WRKQ = 24
const MID_WALK_HRC = 24

export const TIMELINE_TARGET = {
  sessionRef: TIMELINE_SESSION_REF,
  hostSessionId: TIMELINE_HOST_SESSION_ID,
  generation: TIMELINE_GENERATION,
}

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

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

async function recordCursorProbe(
  current: TimelineStack,
  report: TimelineEvidence,
  name: string,
  query: Partial<HistoryQuery>
): Promise<void> {
  const response = await readHistory(current, { ...TIMELINE_TARGET, ...query })
  report.boundedReads.historyRequests += 1
  report.negatives[name] = {
    status: response.status,
    code: response.body.code,
    atoms: response.body.atoms?.length ?? 0,
  }
}

type HistoryExpectations = {
  expectedHrcAtomIds: string[]
  expectedWrkqAtomIds: string[]
  frameSeqByLabel: ReadonlyMap<string, number>
}

function recordHistoryOrdering(
  report: TimelineEvidence,
  observed: MobileTimelineAtomWire[],
  { expectedHrcAtomIds, expectedWrkqAtomIds, frameSeqByLabel }: HistoryExpectations,
  arrivals: { midWalkWrkqIds: string[]; midWalkHrcAtomIds: string[]; racedIds: string[] }
): void {
  const hrcIncarnation = report.identity.hrcLedgerIncarnationId
  report.oracle.observedAtoms = observed.length

  const observedAtoms = observed.map(toOracleAtom)
  const expected = [...expectedHrcAtomIds, ...expectedWrkqAtomIds]
  const expectedIds = new Set(expected)
  const findings = [
    ...compareIdentitySets(
      'exactly_once_no_gaps',
      expected,
      observed
        .map((atom) => atom.atomId)
        // Arrivals injected during the walk legitimately sit above the
        // snapshot; they are gated separately and are not part of the
        // seeded historical identity set.
        .filter((id) => expectedIds.has(id))
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
      !expectedIds.has(atom.atomId) &&
      !arrivals.midWalkWrkqIds.some((id) => atom.atomId.includes(id)) &&
      !arrivals.midWalkHrcAtomIds.includes(atom.atomId) &&
      !arrivals.racedIds.includes(atom.atomId)
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
}

export async function checkTimelineHistory(
  current: TimelineStack,
  report: TimelineEvidence,
  driver: LiveHrcDriver,
  input: HistoryExpectations & {
    history: Omit<HistoryPageWire, 'snapshotHighWater'>
    racedIds: string[]
  },
  mark: (phase: string) => void
): Promise<string> {
  const { history, racedIds, expectedHrcAtomIds, expectedWrkqAtomIds } = input
  const hrcIncarnation = report.identity.hrcLedgerIncarnationId
  const walked: MobileTimelineAtomWire[] = []
  const pageAtomsByCursor = new Map<string, MobileTimelineAtomWire[]>()
  const walkCursors: string[] = []
  let cursor = history.olderCursor
  let pageIndex = 0
  const midWalkWrkqIds: string[] = []
  const midWalkHrcAtomIds: string[] = []

  while (cursor !== null && pageIndex < MAX_HISTORY_PAGES) {
    const response = await readHistory(current, {
      ...TIMELINE_TARGET,
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
    report.boundedReads.maxPageBytes = Math.max(report.boundedReads.maxPageBytes, response.bytes)
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

    if (pageIndex === 2) {
      const midWrkq = await seedCollaborationEnvelopes(current, {
        speakerHandle: TIMELINE_SENDER_HANDLE,
        speakerPrincipalRef: TIMELINE_SENDER_PRINCIPAL,
        addresseeHandle: TIMELINE_MEMBER_HANDLE,
        bodies: Array.from(
          { length: MID_WALK_WRKQ },
          (_unused, index) => `mid-walk envelope ${index}`
        ),
      })
      for (const envelope of midWrkq) midWalkWrkqIds.push(envelope.messageId)
      for (let index = 0; index < MID_WALK_HRC; index++) {
        const events = await driver.submit(TIMELINE_SESSION_REF, `mid-walk prompt ${index}`)
        midWalkHrcAtomIds.push(...projectableHrcAtomIds(hrcIncarnation, events))
      }
    }

    cursor = response.body.olderCursor
    pageIndex += 1
  }
  mark('older_paging')
  report.gates['older_paging_terminated'] = {
    ok: pageIndex < MAX_HISTORY_PAGES,
    detail: `walked ${pageIndex} older pages (cap ${MAX_HISTORY_PAGES})`,
  }

  // The walk prepends older pages, so the snapshot belongs at the end.
  recordHistoryOrdering(report, [...walked, ...history.atoms], input, {
    midWalkWrkqIds,
    midWalkHrcAtomIds,
    racedIds,
  })

  // Replay the second delivered page twice against its original atoms.
  const replayCursor = walkCursors[1]
  if (replayCursor !== undefined) {
    const query = { ...TIMELINE_TARGET, limit: HISTORY_PAGE_LIMIT, cursor: replayCursor }
    const first = await readHistory(current, query)
    const second = await readHistory(current, query)
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

  const liveCursor = walkCursors[0] ?? ''
  await recordCursorProbe(current, report, 'malformed_cursor', {
    cursor: '!!! not base64url !!!',
  })
  await recordCursorProbe(current, report, 'wrong_generation_cursor', {
    generation: SIBLING_GENERATION,
    cursor: liveCursor,
  })
  await recordCursorProbe(current, report, 'wrong_session_cursor', {
    sessionRef: DECOY_SESSION_REF,
    hostSessionId: DECOY_HOST_SESSION_ID,
    cursor: liveCursor,
  })
  if (liveCursor.length > 0) {
    const payload = decodeCursor(liveCursor)
    await recordCursorProbe(current, report, 'future_ordinal_cursor', {
      cursor: encodeCursor({
        ...payload,
        beforeTimelineOrdinal: String(
          BigInt(payload['beforeTimelineOrdinal'] as string) + 1_000_000n
        ),
      }),
    })
    await recordCursorProbe(current, report, 'retired_producer_cursor_type', {
      cursor: encodeCursor({ ...payload, type: 'mobile_live' }),
    })
  }
  await recordCursorProbe(current, report, 'raw_producer_cursor_retired', {
    extra: { beforeHrcSeq: '10' },
  })

  // Sibling generation opens its own timeline and shares no identity.
  const siblingOpen = await readHistory(current, {
    ...TIMELINE_TARGET,
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

  return liveCursor
}

export async function checkLedgerReplacement(
  current: TimelineStack,
  report: TimelineEvidence,
  liveCursor: string
): Promise<void> {
  await replaceHrcLedgerIncarnation(current)
  const afterHrcReplacement = await readHistory(current, {
    ...TIMELINE_TARGET,
    limit: HISTORY_PAGE_LIMIT,
  })
  report.boundedReads.historyRequests += 1
  report.gates['hrc_ledger_replacement_resets'] = {
    ok:
      afterHrcReplacement.status === 200 &&
      afterHrcReplacement.body.resetReason === 'producer_incarnation_changed',
    detail: `status=${afterHrcReplacement.status} resetReason=${afterHrcReplacement.body.resetReason ?? 'none'} epoch=${afterHrcReplacement.body.projectionEpoch}`,
  }
  await recordCursorProbe(current, report, 'cursor_after_hrc_ledger_replacement', {
    cursor: liveCursor,
  })

  replaceCollaborationLedgerIncarnation(current)
  const afterWrkqReplacement = await readHistory(current, {
    ...TIMELINE_TARGET,
    limit: HISTORY_PAGE_LIMIT,
  })
  report.boundedReads.historyRequests += 1
  report.gates['wrkq_ledger_replacement_resets'] = {
    ok:
      afterWrkqReplacement.status === 200 &&
      afterWrkqReplacement.body.resetReason === 'producer_incarnation_changed',
    detail: `status=${afterWrkqReplacement.status} resetReason=${afterWrkqReplacement.body.resetReason ?? 'none'}`,
  }
}
