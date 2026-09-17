import { describe, expect, test } from 'bun:test'
import { openAcpStateStore } from 'acp-state-store'
import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { CollaborationLedger } from 'wrkq-lib'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../src/deps.js'
import type { MobileWebSocketLike } from '../src/handlers/mobile-ws.js'
import { openMobileWebSocket } from '../src/handlers/mobile.js'

const HOST_SESSION_ID = 'hsid-retained-timeline'
const SCOPE_REF = 'agent:smokey:project:agent-control-plane:task:T-08575'
const GENERATION = 7
const NOW = '2026-09-16T18:00:00.000Z'

const session: HrcSessionRecord = {
  hostSessionId: HOST_SESSION_ID,
  scopeRef: SCOPE_REF,
  laneRef: 'main',
  generation: GENERATION,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  ancestorScopeRefs: [],
}

const runtime: HrcRuntimeSnapshot = {
  runtimeId: 'rt-retained-timeline',
  hostSessionId: HOST_SESSION_ID,
  scopeRef: SCOPE_REF,
  laneRef: 'main',
  generation: GENERATION,
  transport: 'tmux',
  harness: 'codex',
  provider: 'openai',
  status: 'active',
  supportsInflightInput: true,
  adopted: false,
  activeRunId: 'run-live',
  createdAt: NOW,
  updatedAt: NOW,
}

const run: HrcRunRecord = {
  runId: 'run-live',
  hostSessionId: HOST_SESSION_ID,
  runtimeId: runtime.runtimeId,
  scopeRef: SCOPE_REF,
  laneRef: 'main',
  generation: GENERATION,
  transport: 'tmux',
  status: 'running',
  acceptedAt: NOW,
  startedAt: NOW,
  updatedAt: NOW,
}

function lifecycleEvent(
  hrcSeq: number,
  eventKind: string,
  input: {
    runId?: string | undefined
    evidenceOrigin?: 'retained' | undefined
    replayed?: boolean | undefined
    payload?: Record<string, unknown> | undefined
  } = {}
): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: new Date(Date.parse(NOW) + hrcSeq * 1_000).toISOString(),
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: GENERATION,
    category: eventKind.startsWith('runtime.') ? 'runtime' : 'turn',
    eventKind,
    replayed: input.replayed ?? false,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    payload:
      input.payload ??
      (eventKind === 'turn.message'
        ? {
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: 'historical reply' }] },
          }
        : { reason: eventKind }),
    ...(input.evidenceOrigin !== undefined ? { evidenceOrigin: input.evidenceOrigin } : {}),
  } as HrcLifecycleEvent & { evidenceOrigin?: 'retained' }
}

function emptyLedger(): CollaborationLedger {
  return {
    async pageMessagesByMember() {
      return {
        ledgerIncarnationId: 'wrkq-retained-timeline',
        headMessageSeq: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        messages: [],
      }
    },
    async listMessagesByMember() {
      return { messages: [] }
    },
    async listMessagesByRoom() {
      return { messages: [] }
    },
    async say() {
      throw new Error('timeline test does not write collaboration messages')
    },
  }
}

async function openTimeline(events: HrcLifecycleEvent[]) {
  const stateStore = openAcpStateStore({ dbPath: ':memory:' })
  const hrcClient = {
    listSessions: async () => [session],
    listRuntimes: async () => [runtime],
    listLatestEventBySession: async () => [events.at(-1)].filter(Boolean),
    getLatestRunForSession: async () => run,
    tailEvents: async (options: { beforeHrcSeq?: number; limit: number }) => {
      const matching = events.filter(
        (event) => options.beforeHrcSeq === undefined || event.hrcSeq < options.beforeHrcSeq
      )
      const selected = matching.slice(-options.limit)
      return {
        events: selected,
        ledgerIncarnationId: 'hrc-retained-timeline',
        headHrcSeq: events.at(-1)?.hrcSeq ?? 0,
        truncated: matching.length > selected.length,
      }
    },
    watchBoundedEvents: () => (async function* () {})(),
  } as unknown as AcpHrcClient
  const deps = {
    hrcClient,
    stateStore,
    collaborationLedger: emptyLedger(),
  } as ResolvedAcpServerDeps
  const sent: Array<Record<string, unknown>> = []
  const ws: MobileWebSocketLike = {
    data: {
      deps,
      url: `http://acp.test/v1/mobile/sessions/${HOST_SESSION_ID}/timeline`,
      kind: 'timeline',
      version: 1,
      hostSessionId: HOST_SESSION_ID,
      abortController: new AbortController(),
    },
    send(raw) {
      const envelope = JSON.parse(raw) as Record<string, unknown>
      sent.push(envelope)
      if (envelope['type'] === 'snapshot') this.data.abortController.abort()
      return raw.length
    },
    close() {},
  }

  try {
    await openMobileWebSocket(ws)
    return sent[0] as {
      type: string
      history: {
        atoms: Array<{
          sourceSeq: number
          logicalFrameId: string
          operation: 'append' | 'replace'
          prefixState: 'complete' | 'unknown'
        }>
      }
    }
  } finally {
    stateStore.close()
  }
}

function baseEvents(): HrcLifecycleEvent[] {
  return [
    lifecycleEvent(1, 'runtime.interrupted'),
    lifecycleEvent(2, 'runtime.stale'),
    lifecycleEvent(3, 'runtime.interrupted', { runId: 'run-live' }),
  ]
}

// T-08575: present-origin status remains visible as append-only history and
// cannot collide with the logical frame IDs used by current status.
describe('T-08575 mobile timeline retained-origin projection', () => {
  test('T5 retained status is append-only history with collision-proof frame identity', async () => {
    const snapshot = await openTimeline([
      ...baseEvents(),
      lifecycleEvent(4, 'runtime.interrupted', { evidenceOrigin: 'retained' }),
      lifecycleEvent(5, 'runtime.stale', { evidenceOrigin: 'retained' }),
      lifecycleEvent(6, 'turn.message', {
        runId: 'run-hist',
        evidenceOrigin: 'retained',
      }),
    ])
    const atoms = snapshot.history.atoms
    expect(atoms.find((atom) => atom.sourceSeq === 4)).toMatchObject({
      operation: 'append',
      logicalFrameId: 'hrc-4',
      prefixState: 'unknown',
    })
    expect(atoms.find((atom) => atom.sourceSeq === 5)).toMatchObject({
      operation: 'append',
      logicalFrameId: 'hrc-5',
      prefixState: 'unknown',
    })
    expect(atoms.some((atom) => atom.sourceSeq === 6)).toBe(true)
    expect(
      atoms.filter((atom) => atom.operation === 'replace').map((atom) => atom.logicalFrameId)
    ).toEqual([
      `turn-status:${HOST_SESSION_ID}`,
      `session-status:${HOST_SESSION_ID}:${GENERATION}`,
      'turn-status:run-live',
    ])
  })

  for (const control of [
    { id: 'C', replayed: false },
    { id: "C'", replayed: true },
  ]) {
    test(`T5 ${control.id} ordinary-origin status keeps today's replace semantics`, async () => {
      const snapshot = await openTimeline([
        ...baseEvents(),
        lifecycleEvent(4, 'runtime.interrupted', { replayed: control.replayed }),
        lifecycleEvent(5, 'runtime.stale', { replayed: control.replayed }),
        lifecycleEvent(6, 'turn.message', {
          runId: 'run-hist',
          replayed: control.replayed,
        }),
      ])
      const atoms = snapshot.history.atoms
      expect(atoms.find((atom) => atom.sourceSeq === 4)).toMatchObject({
        operation: 'replace',
        logicalFrameId: `turn-status:${HOST_SESSION_ID}`,
      })
      expect(atoms.find((atom) => atom.sourceSeq === 5)).toMatchObject({
        operation: 'replace',
        logicalFrameId: `session-status:${HOST_SESSION_ID}:${GENERATION}`,
      })
      expect(atoms.some((atom) => atom.sourceSeq === 6)).toBe(true)
    })
  }
})
