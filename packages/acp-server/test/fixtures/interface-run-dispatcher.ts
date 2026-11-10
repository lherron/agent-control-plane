import { Database } from 'bun:sqlite'
import { setSystemTime } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openInterfaceStore } from 'acp-interface-store'
import { InMemoryRunStore, type StoredRun } from '../../src/domain/run-store.js'
import type { HrcRouteReader } from '../../src/hrc-route-reader.js'
import * as dispatcherModule from '../../src/integration/interface-run-dispatcher.js'
import { createHrcRouteFake } from './hrc-route-fake.js'

// Shared persisted state for dispatcher reconciliation tests. Each suite installs
// cleanup explicitly so importing this fixture never registers lifecycle hooks.
const fixtureDirs: string[] = []

export function cleanupFixtureDirs(): void {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

function createFixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  fixtureDirs.push(dir)
  return dir
}

export function createInterfaceStore(prefix = 'acp-interface-dispatch-') {
  return openInterfaceStore({ dbPath: join(createFixtureDir(prefix), 'interface.sqlite') })
}

export type HrcFixture = { db: Database; hrcFixture: string; routes: HrcRouteReader }

export function createHrcDb(evidenceOrigin = false): HrcFixture {
  const fixtureDir = createFixtureDir(
    evidenceOrigin ? 'acp-interface-retained-' : 'acp-interface-stale-'
  )
  const hrcFixture = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcFixture)
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      host_session_id TEXT NOT NULL,
      runtime_id TEXT,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      accepted_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      operation_id TEXT,
      invocation_id TEXT,
      dispatched_input_id TEXT
    );

    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_seq INTEGER NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      runtime_id TEXT,
      run_id TEXT,
      launch_id TEXT,
      app_id TEXT,
      app_session_key TEXT,
      category TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      transport TEXT,
      error_code TEXT,
      replayed INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL${
        evidenceOrigin
          ? ",\n      evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
          : ''
      }
    );
  `)
  return { db, hrcFixture, routes: createHrcRouteFake(hrcFixture) }
}

export function insertRunStatus(
  db: Database,
  input: {
    runId: string
    hostSessionId: string
    runtimeId?: string | undefined
    scopeRef: string
    laneRef: string
    generation: number
    transport: string
    status: string
    errorCode?: string | undefined
    errorMessage?: string | undefined
  }
): void {
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO runs (
      run_id,
      host_session_id,
      runtime_id,
      scope_ref,
      lane_ref,
      generation,
      transport,
      status,
      accepted_at,
      started_at,
      completed_at,
      updated_at,
      error_code,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.runId,
    input.hostSessionId,
    input.runtimeId ?? null,
    input.scopeRef,
    input.laneRef,
    input.generation,
    input.transport,
    input.status,
    now,
    now,
    input.status === 'completed' ||
      input.status === 'failed' ||
      input.status === 'cancelled' ||
      input.status === 'terminated'
      ? now
      : null,
    now,
    input.errorCode ?? null,
    input.errorMessage ?? null
  )
}

export function insertHrcEvent(
  db: Database,
  input: {
    ts: string
    runId: string | undefined
    hostSessionId: string | undefined
    scopeRef: string
    laneRef: string
    generation: number | undefined
  }
): void {
  db.run(
    `INSERT INTO hrc_events (
      stream_seq,
      ts,
      host_session_id,
      scope_ref,
      lane_ref,
      generation,
      run_id,
      category,
      event_kind,
      payload_json
    ) VALUES (
      (SELECT COALESCE(MAX(stream_seq), 0) + 1 FROM hrc_events),
      ?, ?, ?, ?, ?, ?, 'turn', 'turn.message', ?
    )`,
    input.ts,
    input.hostSessionId ?? 'hsid-default',
    input.scopeRef,
    input.laneRef,
    input.generation ?? 0,
    input.runId ?? null,
    JSON.stringify({ type: 'turn_delta', text: 'progress' })
  )
}

export function insertAssistantMessage(
  db: Database,
  input: {
    hrcSeq: number
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId: string
    text: string
  }
): void {
  insertSessionEvent(db, {
    ...input,
    eventKind: 'turn.message',
    payload: assistantPayload(input.text),
  })
}

export function insertTurnCompleted(
  db: Database,
  input: {
    hrcSeq: number
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId: string
  }
): void {
  insertSessionEvent(db, {
    ...input,
    eventKind: 'turn.completed',
    payload: {
      success: true,
      transport: 'tmux',
    },
  })
}

export function insertSessionEvent(
  db: Database,
  input: {
    hrcSeq: number
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId: string
    eventKind: string
    payload: Record<string, unknown>
  }
): void {
  db.run(
    `INSERT INTO hrc_events (
      hrc_seq,
      stream_seq,
      ts,
      host_session_id,
      scope_ref,
      lane_ref,
      generation,
      run_id,
      category,
      event_kind,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?)`,
    input.hrcSeq,
    input.hrcSeq,
    new Date().toISOString(),
    input.hostSessionId,
    input.scopeRef,
    input.laneRef,
    input.generation,
    input.runId,
    input.eventKind,
    JSON.stringify(input.payload)
  )
}

export function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const now = new Date().toISOString()
  return {
    runId: 'acp-run-1',
    scopeRef: 'agent:smokey:project:agent-spaces',
    laneRef: 'main',
    actor: { kind: 'user', id: 'discord:user:1' },
    status: 'running',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

export function isoAgo(now: number, ageMs: number): string {
  return new Date(now - ageMs).toISOString()
}

type EvidenceOrigin = 'retained' | null

export function createEvidenceHrcDb(): HrcFixture {
  return createHrcDb(true)
}

export function insertEvidenceEvent(
  db: Database,
  input: {
    hrcSeq: number
    ts?: string | undefined
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId?: string | undefined
    eventKind: string
    payload: Record<string, unknown>
    evidenceOrigin: EvidenceOrigin
    replayed?: boolean | undefined
  }
): void {
  db.run(
    `INSERT INTO hrc_events (
      hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
      run_id, category, event_kind, replayed, payload_json, evidence_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?, ?, ?)`,
    input.hrcSeq,
    input.hrcSeq,
    input.ts ?? new Date().toISOString(),
    input.hostSessionId,
    input.scopeRef,
    input.laneRef,
    input.generation,
    input.runId ?? null,
    input.eventKind,
    input.replayed === true ? 1 : 0,
    JSON.stringify(input.payload),
    input.evidenceOrigin
  )
}

function assistantPayload(text: string): Record<string, unknown> {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

export function createTmuxActuationFixture(input: {
  hrc: HrcRouteReader
  runStore?: InMemoryRunStore | undefined
  generation?: number | undefined
  hrcRunId?: string | undefined
  bornAgoMs?: number | undefined
  staleTimeoutMs?: number | undefined
}) {
  const interfaceStore = createInterfaceStore('acp-interface-retained-store-')
  const runStore = input.runStore ?? new InMemoryRunStore()
  const sessionRef = {
    scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
    laneRef: 'main' as const,
  }
  if (input.bornAgoMs !== undefined) setSystemTime(new Date(Date.now() - input.bornAgoMs))
  let run: StoredRun
  try {
    run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_retained',
            conversationRef: 'channel:retained',
            messageRef: 'discord:message:prompt',
            replyToMessageRef: 'discord:message:prompt',
          },
        },
      },
    })
    runStore.updateRun(run.runId, {
      hostSessionId: 'hsid-retained',
      runtimeId: 'rt-retained',
      transport: input.hrcRunId === undefined ? 'tmux' : 'headless',
      afterHrcSeq: 10,
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(input.hrcRunId !== undefined ? { hrcRunId: input.hrcRunId } : {}),
    })
  } finally {
    if (input.bornAgoMs !== undefined) setSystemTime()
  }
  const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
    runStore,
    interfaceStore,
    hrc: input.hrc,
    config: { intervalMs: 1, staleTimeoutMs: input.staleTimeoutMs ?? 10 },
  })
  return { dispatcher, interfaceStore, runStore, run, sessionRef }
}

export function insertCompletedPair(
  db: Database,
  input: {
    firstSeq: number
    text: string
    runId: string
    evidenceOrigin: EvidenceOrigin
    replayed?: boolean | undefined
    ts?: string | undefined
  }
): void {
  const common = {
    hostSessionId: 'hsid-retained',
    scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
    laneRef: 'main',
    generation: 7,
    runId: input.runId,
    evidenceOrigin: input.evidenceOrigin,
    replayed: input.replayed,
    ts: input.ts,
  }
  insertEvidenceEvent(db, {
    ...common,
    hrcSeq: input.firstSeq,
    eventKind: 'turn.message',
    payload: assistantPayload(input.text),
  })
  insertEvidenceEvent(db, {
    ...common,
    hrcSeq: input.firstSeq + 1,
    eventKind: 'turn.completed',
    payload: { success: true, transport: 'tmux' },
  })
}
