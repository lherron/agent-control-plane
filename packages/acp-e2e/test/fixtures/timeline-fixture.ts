/**
 * Deterministic fixture declaration and source-grounded ordering oracle for the
 * mobile timeline production-wire E2E (T-07724).
 *
 * The oracle deliberately never imports the ACP projector, the mobile handlers,
 * or their DTOs. It reasons from two things only:
 *
 *   1. canonical producer identities — HRC `hrcSeq` under the exact
 *      `(hostSessionId, generation)`, and wrkq `EN-` envelope ids/`messageSeq`
 *      for the exact member — read back from the real producers, and
 *   2. the approved presentation contract of P-00454 / T-07718, restated here
 *      as explicit per-record declarations (`projects`, `logicalFrameId`,
 *      `operation`) made at fixture-construction time.
 *
 * That is why every seeded record carries its own declaration: a record's
 * expected contribution is a property of the fixture, not something recomputed
 * by calling the code under test.
 */

import type { HrcLifecycleEventInput } from 'hrc-store-sqlite'

export const TIMELINE_AGENT_ID = 'tlagent'
export const TIMELINE_PROJECT_ID = 'tlproj'
export const TIMELINE_SCOPE_REF = `agent:${TIMELINE_AGENT_ID}:project:${TIMELINE_PROJECT_ID}`
export const TIMELINE_LANE_REF = 'main'
export const TIMELINE_SESSION_REF = `${TIMELINE_SCOPE_REF}/lane:${TIMELINE_LANE_REF}`
export const TIMELINE_MEMBER_HANDLE = `${TIMELINE_AGENT_ID}@${TIMELINE_PROJECT_ID}`
export const TIMELINE_SENDER_HANDLE = `tlsender@${TIMELINE_PROJECT_ID}`
export const TIMELINE_HOST_SESSION_ID = 'hs-timeline-e2e'
export const TIMELINE_GENERATION = 7
export const SIBLING_GENERATION = 6

/** A deliberately similar-looking second session; it must never leak or page. */
export const DECOY_AGENT_ID = 'tldecoy'
export const DECOY_SCOPE_REF = `agent:${DECOY_AGENT_ID}:project:${TIMELINE_PROJECT_ID}`
export const DECOY_SESSION_REF = `${DECOY_SCOPE_REF}/lane:${TIMELINE_LANE_REF}`
export const DECOY_MEMBER_HANDLE = `${DECOY_AGENT_ID}@${TIMELINE_PROJECT_ID}`
export const DECOY_HOST_SESSION_ID = 'hs-timeline-e2e-decoy'

export const FRAME_RUN_ID = 'run-noncontiguous'
export const CHUNK_RUN_ID = 'run-chunked-response'
export const CHUNK_COUNT = 1_000
export const BULK_EVENT_COUNT = 8_500
export const REPEATED_TS_COUNT = 200
export const REGRESSING_TS_COUNT = 200
export const INTERLEAVE_COUNT = 140

/**
 * One seeded HRC record plus the contribution the approved contract says it
 * makes. `projects: false` records are real lifecycle noise: they must occupy
 * ledger positions and bounded-read capacity without ever becoming atoms.
 */
export type HrcSeedSpec = {
  label: string
  event: HrcLifecycleEventInput
  projects: boolean
  /** Declared expected logical frame id; only meaningful when `projects`. */
  logicalFrameId?: string | undefined
  /** Declared expected atom operation; only meaningful when `projects`. */
  operation?: 'append' | 'replace' | undefined
}

/** A seeded record after it has been given its canonical HRC identity. */
export type SeededHrcRecord = HrcSeedSpec & { hrcSeq: number; ts: string }

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function targetEvent(
  eventKind: string,
  category: HrcLifecycleEventInput['category'],
  ts: string,
  payload: unknown,
  extra: Partial<HrcLifecycleEventInput> = {}
): HrcLifecycleEventInput {
  return {
    ts,
    hostSessionId: TIMELINE_HOST_SESSION_ID,
    scopeRef: TIMELINE_SCOPE_REF,
    laneRef: TIMELINE_LANE_REF,
    generation: TIMELINE_GENERATION,
    category,
    eventKind,
    payload,
    ...extra,
  }
}

/**
 * The exact-generation history under test.
 *
 * `collaborationSeconds` are the real `createdAt` values wrkq assigned to the
 * seeded envelopes. Feeding them back into the newest HRC records is what makes
 * the two producers genuinely interleave (and tie) inside the same closed
 * cohorts instead of separating into two time-disjoint blocks.
 */
export function buildTargetHistorySpecs(input: {
  anchorMs: number
  collaborationSeconds: readonly string[]
}): HrcSeedSpec[] {
  const specs: HrcSeedSpec[] = []
  const bulkStart = input.anchorMs - 6 * 60 * 60 * 1000

  // ── Segment 1: bulk lifecycle history, 2 of every 5 records projecting ────
  for (let index = 0; index < BULK_EVENT_COUNT; index += 1) {
    const ts = iso(bulkStart + index * 500)
    const slot = index % 5
    const block = Math.floor(index / 5)
    if (slot === 0) {
      specs.push({
        label: `bulk.tool_call.${index}`,
        projects: true,
        logicalFrameId: `tool:tu-bulk-${block}`,
        operation: 'append',
        event: targetEvent('turn.tool_call', 'turn', ts, {
          toolName: 'Bash',
          toolUseId: `tu-bulk-${block}`,
          input: { command: `echo bulk ${block}` },
        }),
      })
      continue
    }
    if (slot === 1) {
      specs.push({
        label: `bulk.tool_result.${index}`,
        projects: true,
        logicalFrameId: `tool:tu-bulk-${block}`,
        operation: 'append',
        event: targetEvent('turn.tool_result', 'turn', ts, {
          toolName: 'Bash',
          toolUseId: `tu-bulk-${block}`,
          result: { stdout: `bulk ${block}` },
        }),
      })
      continue
    }
    if (slot === 2) {
      specs.push({
        label: `bulk.turn_completed.${index}`,
        projects: false,
        event: targetEvent('turn.completed', 'turn', ts, { ok: true, block }),
      })
      continue
    }
    if (slot === 3) {
      specs.push({
        label: `bulk.session_heartbeat.${index}`,
        projects: false,
        event: targetEvent('session.heartbeat', 'session', ts, { block }),
      })
      continue
    }
    specs.push({
      label: `bulk.runtime_probe.${index}`,
      projects: false,
      event: targetEvent('runtime.probed', 'runtime', ts, { block }),
    })
  }

  // ── Segment 2: repeated timestamps ───────────────────────────────────────
  const repeatedTs = iso(input.anchorMs - 2 * 60 * 60 * 1000)
  for (let index = 0; index < REPEATED_TS_COUNT; index += 1) {
    specs.push({
      label: `repeated.${index}`,
      projects: true,
      logicalFrameId: 'assistant:run-repeated-ts:7',
      operation: 'append',
      event: targetEvent(
        'turn.message',
        'turn',
        repeatedTs,
        { text: `repeated timestamp message ${index}` },
        { runId: 'run-repeated-ts' }
      ),
    })
  }

  // ── Segment 3: clock regression (ts falls while hrcSeq rises) ────────────
  const regressStart = input.anchorMs - 60 * 60 * 1000
  for (let index = 0; index < REGRESSING_TS_COUNT; index += 1) {
    specs.push({
      label: `regressing.${index}`,
      projects: true,
      logicalFrameId: 'assistant:run-regressing-ts:7',
      operation: 'append',
      event: targetEvent(
        'turn.message',
        'turn',
        iso(regressStart - index * 1_000),
        { text: `clock regressing message ${index}` },
        { runId: 'run-regressing-ts' }
      ),
    })
  }

  // ── Segment 4: non-contiguous contributions to one logical response ──────
  const frameStart = input.anchorMs - 30 * 60 * 1000
  specs.push({
    label: 'frame.assistant.first',
    projects: true,
    logicalFrameId: `assistant:${FRAME_RUN_ID}:${TIMELINE_GENERATION}`,
    operation: 'append',
    event: targetEvent(
      'turn.message',
      'turn',
      iso(frameStart),
      { text: 'assistant response part one' },
      { runId: FRAME_RUN_ID }
    ),
  })
  specs.push({
    label: 'frame.tool_call',
    projects: true,
    logicalFrameId: 'tool:tu-noncontiguous',
    operation: 'append',
    event: targetEvent(
      'turn.tool_call',
      'turn',
      iso(frameStart + 1_000),
      { toolName: 'Read', toolUseId: 'tu-noncontiguous', input: { path: '/tmp/x' } },
      { runId: FRAME_RUN_ID }
    ),
  })
  specs.push({
    label: 'frame.tool_result',
    projects: true,
    logicalFrameId: 'tool:tu-noncontiguous',
    operation: 'append',
    event: targetEvent(
      'turn.tool_result',
      'turn',
      iso(frameStart + 2_000),
      { toolName: 'Read', toolUseId: 'tu-noncontiguous', result: { bytes: 12 } },
      { runId: FRAME_RUN_ID }
    ),
  })
  specs.push({
    label: 'frame.status',
    projects: true,
    logicalFrameId: `turn-status:${FRAME_RUN_ID}`,
    operation: 'replace',
    event: targetEvent(
      'runtime.interrupted',
      'runtime',
      iso(frameStart + 3_000),
      { reason: 'operator' },
      { runId: FRAME_RUN_ID }
    ),
  })
  specs.push({
    label: 'frame.assistant.second',
    projects: true,
    logicalFrameId: `assistant:${FRAME_RUN_ID}:${TIMELINE_GENERATION}`,
    operation: 'append',
    event: targetEvent(
      'turn.message',
      'turn',
      iso(frameStart + 4_000),
      { text: 'assistant response part two' },
      { runId: FRAME_RUN_ID }
    ),
  })

  // ── Segment 5: one response spanning 1,000 message chunks ────────────────
  const chunkStart = input.anchorMs - 20 * 60 * 1000
  for (let index = 0; index < CHUNK_COUNT; index += 1) {
    specs.push({
      label: `chunk.${index}`,
      projects: true,
      logicalFrameId: `assistant:${CHUNK_RUN_ID}:${TIMELINE_GENERATION}`,
      operation: 'append',
      event: targetEvent(
        'turn.message',
        'turn',
        iso(chunkStart + index * 100),
        { text: `chunk ${index} of the long response` },
        { runId: CHUNK_RUN_ID }
      ),
    })
  }

  // ── Segment 6: newest records timed onto the collaboration ledger ────────
  const seconds =
    input.collaborationSeconds.length > 0 ? input.collaborationSeconds : [iso(input.anchorMs)]
  for (let index = 0; index < INTERLEAVE_COUNT; index += 1) {
    const ts = seconds[Math.floor((index * seconds.length) / INTERLEAVE_COUNT)] as string
    specs.push({
      label: `interleave.${index}`,
      projects: true,
      logicalFrameId: 'assistant:run-interleave:7',
      operation: 'append',
      event: targetEvent(
        'turn.message',
        'turn',
        ts,
        { text: `interleaved assistant message ${index}` },
        { runId: 'run-interleave' }
      ),
    })
  }

  return specs
}

/**
 * Sibling-generation and foreign-session records. They carry deliberately
 * similar text so a projector that matched on content rather than exact
 * identity would fail; they must never appear, and must never consume the
 * selected timeline's bounded page capacity.
 */
export function buildDecoySpecs(input: { anchorMs: number; count: number }): HrcSeedSpec[] {
  const specs: HrcSeedSpec[] = []
  const start = input.anchorMs - 5 * 60 * 60 * 1000
  for (let index = 0; index < input.count; index += 1) {
    const ts = iso(start + index * 500)
    if (index % 2 === 0) {
      specs.push({
        label: `decoy.sibling_generation.${index}`,
        projects: false,
        event: {
          ts,
          hostSessionId: TIMELINE_HOST_SESSION_ID,
          scopeRef: TIMELINE_SCOPE_REF,
          laneRef: TIMELINE_LANE_REF,
          generation: SIBLING_GENERATION,
          runId: 'run-sibling',
          category: 'turn',
          eventKind: 'turn.message',
          payload: { text: `chunk ${index} of the long response` },
        },
      })
      continue
    }
    specs.push({
      label: `decoy.other_session.${index}`,
      projects: false,
      event: {
        ts,
        hostSessionId: DECOY_HOST_SESSION_ID,
        scopeRef: DECOY_SCOPE_REF,
        laneRef: TIMELINE_LANE_REF,
        generation: TIMELINE_GENERATION,
        runId: 'run-decoy',
        category: 'turn',
        eventKind: 'turn.message',
        payload: { text: `chunk ${index} of the long response` },
      },
    })
  }
  return specs
}

/**
 * Splice decoys physically through the target history so foreign rows occupy
 * adjacent ledger positions. Relative order inside each stream is preserved, so
 * the target stream's declared `hrcSeq` order still follows its array order.
 */
export function spliceStreams(
  target: readonly HrcSeedSpec[],
  decoys: readonly HrcSeedSpec[]
): { combined: HrcSeedSpec[]; targetIndices: number[] } {
  const combined: HrcSeedSpec[] = []
  const targetIndices: number[] = []
  const stride =
    decoys.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(target.length / decoys.length))
  let decoyIndex = 0
  for (let index = 0; index < target.length; index += 1) {
    targetIndices.push(combined.length)
    combined.push(target[index] as HrcSeedSpec)
    if (index % stride === stride - 1 && decoyIndex < decoys.length) {
      combined.push(decoys[decoyIndex] as HrcSeedSpec)
      decoyIndex += 1
    }
  }
  while (decoyIndex < decoys.length) {
    combined.push(decoys[decoyIndex] as HrcSeedSpec)
    decoyIndex += 1
  }
  return { combined, targetIndices }
}

// ── Oracle ──────────────────────────────────────────────────────────────────

export type OracleAtom = {
  atomId: string
  sourceKind: 'hrc' | 'wrkq'
  sourceSeq: number
  timelineOrdinal: bigint
  logicalFrameId: string
  operation: string
}

export type OracleSource = {
  /** Every exact-generation HRC record the contract says contributes an atom. */
  hrcAtomIds: string[]
  /** Every collaboration envelope the contract says contributes an atom. */
  wrkqAtomIds: string[]
  hrcSeqByAtomId: Map<string, number>
  wrkqSeqByAtomId: Map<string, number>
}

export function hrcAtomId(ledgerIncarnationId: string, hrcSeq: number): string {
  return `hrc:${ledgerIncarnationId}:${hrcSeq}`
}

export function wrkqAtomId(
  ledgerIncarnationId: string,
  messageId: string,
  messageSeq: number
): string {
  return `wrkq:${ledgerIncarnationId}:${messageId}:${messageSeq}`
}

export type OracleFinding = {
  gate: string
  detail: string
  /** First offending position in the observed order, when positional. */
  index?: number | undefined
  atomId?: string | undefined
}

/**
 * Exactly-once / no-gap comparison between the canonical expected identity set
 * and the identities actually delivered.
 */
export function compareIdentitySets(
  gate: string,
  expected: readonly string[],
  observed: readonly string[]
): OracleFinding[] {
  const findings: OracleFinding[] = []
  const counts = new Map<string, number>()
  for (const id of observed) counts.set(id, (counts.get(id) ?? 0) + 1)
  for (const [id, count] of counts) {
    if (count > 1) {
      findings.push({
        gate,
        detail: `delivered ${count} times (expected exactly once)`,
        atomId: id,
      })
      if (findings.length >= 8) return findings
    }
  }
  const expectedSet = new Set(expected)
  for (const id of expectedSet) {
    if (!counts.has(id)) {
      findings.push({
        gate,
        detail: 'expected source contribution was never delivered',
        atomId: id,
      })
      if (findings.length >= 8) return findings
    }
  }
  for (const id of counts.keys()) {
    if (!expectedSet.has(id)) {
      findings.push({
        gate,
        detail: 'unexpected atom delivered (foreign or duplicate source)',
        atomId: id,
      })
      if (findings.length >= 8) return findings
    }
  }
  return findings
}

/** Ordinals must be strictly increasing, numerically, across the whole walk. */
export function checkOrdinalMonotonicity(
  gate: string,
  atoms: readonly OracleAtom[]
): OracleFinding[] {
  const findings: OracleFinding[] = []
  for (let index = 1; index < atoms.length; index += 1) {
    const previous = atoms[index - 1] as OracleAtom
    const current = atoms[index] as OracleAtom
    if (current.timelineOrdinal <= previous.timelineOrdinal) {
      findings.push({
        gate,
        index,
        atomId: current.atomId,
        detail: `ordinal ${current.timelineOrdinal} does not increase after ${previous.timelineOrdinal}`,
      })
      if (findings.length >= 8) return findings
    }
  }
  return findings
}

/**
 * The core ordering invariant: whatever the cross-source interleave, each
 * producer's own sequence must be preserved — including where source
 * timestamps repeat or regress.
 */
export function checkSourceSequencePreserved(
  gate: string,
  atoms: readonly OracleAtom[]
): OracleFinding[] {
  const findings: OracleFinding[] = []
  const lastSeq = new Map<string, { seq: number; atomId: string }>()
  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index] as OracleAtom
    const previous = lastSeq.get(atom.sourceKind)
    if (previous !== undefined && atom.sourceSeq <= previous.seq) {
      findings.push({
        gate,
        index,
        atomId: atom.atomId,
        detail: `${atom.sourceKind} sequence ${atom.sourceSeq} does not follow ${previous.seq} (${previous.atomId})`,
      })
      if (findings.length >= 8) return findings
    }
    lastSeq.set(atom.sourceKind, { seq: atom.sourceSeq, atomId: atom.atomId })
  }
  return findings
}
