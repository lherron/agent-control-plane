import {
  CHUNK_COUNT,
  type OracleFinding,
  TIMELINE_GENERATION,
  TIMELINE_HOST_SESSION_ID,
  TIMELINE_MEMBER_HANDLE,
  TIMELINE_SESSION_REF,
} from './timeline-fixture.js'
import type { TimelineStack } from './timeline-stack.js'

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

export type TimelineEvidence = ReturnType<typeof createTimelineEvidence> & { finishedAt?: string }

export function createTimelineEvidence(startedAt: string, stack: TimelineStack) {
  return {
    startedAt,
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
      apiBase: stack.apiBase,
      loopbackBase: stack.loopbackBase,
      bearerEnforcedOnApiBase: stack.bearerEnforcedOnApiBase,
      unauthenticatedStatus: null as number | null,
      wrongTokenStatus: null as number | null,
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
      historyPages: [] as PageEvidence[],
      totalHistoryAtoms: 0,
      totalHistoryBytes: 0,
      maxPageBytes: 0,
      maxPageAtoms: 0,
    },
    snapshot: {
      envelopeCount: 0,
      atomCount: 0,
      highWater: { hrcSeq: 0, messageSeq: 0 },
      olderCursor: null as string | null,
      replayAfterSnapshot: 0,
    },
    live: {
      atomsDelivered: 0,
      duplicateAtomIds: [] as string[],
      dedupSuppressedEnvelopeId: null as string | null,
      dedupCarrierAtomId: null as string | null,
    },
    oracle: {
      expectedHrcAtoms: 0,
      expectedWrkqAtoms: 0,
      observedAtoms: 0,
      findings: [] as OracleFinding[],
    },
    negatives: {} as Record<string, { status: number; code?: string | undefined; atoms: number }>,
    gates: {} as Record<string, { ok: boolean; detail: string }>,
    phaseMs: {} as Record<string, number>,
    notes: [
      'Inbound collaboration envelopes are held by the live seam for the 120s collaboration match window before admission; the snapshot-race and live-burst gates therefore use envelopes spoken by the session scope, and the inbound path is gated through the dedup carrier instead.',
    ],
  }
}
