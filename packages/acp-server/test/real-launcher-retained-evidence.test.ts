import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { createRealLauncher, readAssistantMessageAfterSeq } from '../src/real-launcher.js'
import { createLauncherRuntimeTables } from './fixtures/launcher-schema.js'

type RetainedLauncherStore = {
  db: Database
  hrcDbPath: string
  fixtureDir: string
}

type SqlStatementFactory = (this: Database, sql: string) => object

function patchSchemaDetection(inject: () => void): {
  injected: () => boolean
  restore: () => void
} {
  const prototype = Database.prototype as unknown as {
    query: SqlStatementFactory
    prepare: SqlStatementFactory
  }
  const originalQuery = prototype.query
  const originalPrepare = prototype.prepare
  let didInject = false

  const wrapStatement = (statement: object, sql: string): object => {
    if (!/table_info/i.test(sql)) return statement
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (
          (property === 'all' || property === 'get' || property === 'values') &&
          typeof value === 'function'
        ) {
          return (...args: unknown[]) => {
            const result = Reflect.apply(value, target, args)
            if (!didInject) {
              inject()
              didInject = true
            }
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  prototype.query = function query(sql: string): object {
    return wrapStatement(originalQuery.call(this, sql), sql)
  }
  prototype.prepare = function prepare(sql: string): object {
    return wrapStatement(originalPrepare.call(this, sql), sql)
  }

  return {
    injected: () => didInject,
    restore: () => {
      prototype.query = originalQuery
      prototype.prepare = originalPrepare
    },
  }
}

function createRetainedLauncherStore(
  input: {
    evidenceColumn?: boolean | undefined
    hrcEventsShape?: 'normal' | 'missing' | 'without-hrc-seq' | undefined
  } = {}
): RetainedLauncherStore {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-retained-'))
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)
  const shape = input.hrcEventsShape ?? 'normal'
  createLauncherRuntimeTables(db)
  if (shape === 'normal') {
    db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        replayed INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL
        ${input.evidenceColumn === true ? ", evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')" : ''}
      );
    `)
  } else if (shape === 'without-hrc-seq') {
    db.exec('CREATE TABLE hrc_events (event_kind TEXT NOT NULL, payload_json TEXT NOT NULL);')
  }
  db.run(
    `INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at)
      VALUES (?, 'main', 'hsid-retained-launcher', ?)`,
    'agent:smokey:project:agent-control-plane:task:T-08575',
    new Date().toISOString()
  )
  db.run(
    `INSERT INTO runtimes (runtime_id, host_session_id, transport, status, tmux_json, updated_at)
      VALUES ('rt-retained-launcher', 'hsid-retained-launcher', 'tmux', 'busy', '{"paneId":"%1"}', ?)`,
    new Date().toISOString()
  )
  return { db, hrcDbPath, fixtureDir }
}

function insertRetainedLauncherEvent(
  db: Database,
  input: {
    hrcSeq: number
    text?: string | undefined
    eventKind?: string | undefined
    runId?: string | undefined
    evidenceOrigin: 'retained' | null
    replayed?: boolean | undefined
  }
): void {
  const eventKind = input.eventKind ?? 'turn.message'
  const payload =
    eventKind === 'turn.message'
      ? { type: 'message_end', message: { role: 'assistant', content: input.text ?? '' } }
      : { success: true, transport: 'tmux' }
  db.run(
    `INSERT INTO hrc_events (
      hrc_seq, host_session_id, scope_ref, lane_ref, generation, run_id,
      event_kind, replayed, payload_json, evidence_origin
    ) VALUES (?, 'hsid-retained-launcher', ?, 'main', 1, ?, ?, ?, ?, ?)`,
    input.hrcSeq,
    'agent:smokey:project:agent-control-plane:task:T-08575',
    input.runId ?? 'run-hist',
    eventKind,
    input.replayed === true ? 1 : 0,
    JSON.stringify(payload),
    input.evidenceOrigin
  )
}

function insertOrdinaryLauncherEvent(
  db: Database,
  input: { hrcSeq: number; text: string; runId?: string | undefined }
): void {
  db.run(
    `INSERT INTO hrc_events (
      hrc_seq, host_session_id, scope_ref, lane_ref, generation, run_id,
      event_kind, replayed, payload_json
    ) VALUES (?, 'hsid-retained-launcher', ?, 'main', 1, ?, 'turn.message', 0, ?)`,
    input.hrcSeq,
    'agent:smokey:project:agent-control-plane:task:T-08575',
    input.runId ?? 'run-live',
    JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: input.text },
    })
  )
}

function retainedLauncherInput(runStore: InMemoryRunStore, acpRunId: string) {
  return {
    sessionRef: {
      scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
      laneRef: 'main' as const,
    },
    acpRunId,
    runStore,
    intent: {
      placement: {
        agentRoot: '/tmp/smokey',
        runMode: 'task' as const,
        bundle: { kind: 'compose' as const, compose: [] },
      },
      harness: { provider: 'openai', interactive: true },
      initialPrompt: 'prove retained evidence is fenced',
    },
  }
}

function retainedAcpRun(runStore: InMemoryRunStore) {
  return runStore.createRun({
    sessionRef: {
      scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
      laneRef: 'main',
    },
    status: 'pending',
  })
}

function retainedLauncherClient(onEnter?: (() => void) | undefined) {
  let calls = 0
  return {
    calls: () => calls,
    client: {
      resolveSession: async () => ({
        found: true,
        hostSessionId: 'hsid-retained-launcher',
        generation: 1,
      }),
      deliverLiteralBySelector: async () => {
        calls += 1
        if (calls === 2) onEnter?.()
        return {
          delivered: true,
          sessionRef: 'agent:smokey:project:agent-control-plane:task:T-08575/lane:main',
          hostSessionId: 'hsid-retained-launcher',
          generation: 1,
          runtimeId: 'rt-retained-launcher',
        }
      },
    } as unknown as any,
  }
}

// T-08575: launcher baselines and no-runId completion waits share the same
// ordinary-origin population, while malformed stores fail before delivery.
describe('T-08575 real launcher retained-evidence fence', () => {
  test('fallback completion wait skips retained-origin history and emits only the later live reply', async () => {
    const store = createRetainedLauncherStore({ evidenceColumn: true })
    const runStore = new InMemoryRunStore()
    const acpRun = retainedAcpRun(runStore)
    const seen: unknown[] = []
    let liveTimer: ReturnType<typeof setTimeout> | undefined
    const client = retainedLauncherClient(() => {
      insertRetainedLauncherEvent(store.db, {
        hrcSeq: 11,
        text: 'OLD-REPLY',
        evidenceOrigin: 'retained',
      })
      insertRetainedLauncherEvent(store.db, {
        hrcSeq: 12,
        eventKind: 'turn.completed',
        evidenceOrigin: 'retained',
      })
      liveTimer = setTimeout(() => {
        insertRetainedLauncherEvent(store.db, {
          hrcSeq: 13,
          text: 'NEW-REPLY',
          runId: 'run-live',
          evidenceOrigin: null,
        })
      }, 8)
    })
    const launcher = createRealLauncher({
      hrcDbPath: store.hrcDbPath,
      pollIntervalMs: 2,
      watchTimeoutMs: 250,
      createClient: () => client.client,
    })

    try {
      await launcher({
        ...retainedLauncherInput(runStore, acpRun.runId),
        waitForCompletion: true,
        onEvent: async (event) => seen.push(event),
      })
      expect(seen).toEqual([
        {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'NEW-REPLY' }] },
        },
      ])
      expect(JSON.stringify(seen)).not.toContain('OLD-REPLY')
    } finally {
      if (liveTimer !== undefined) clearTimeout(liveTimer)
      store.db.close()
      rmSync(store.fixtureDir, { recursive: true, force: true })
    }
  })

  test('fallback completion wait accepts an ordinary-origin reply written at enter', async () => {
    const store = createRetainedLauncherStore({ evidenceColumn: true })
    const runStore = new InMemoryRunStore()
    const acpRun = retainedAcpRun(runStore)
    const seen: unknown[] = []
    const client = retainedLauncherClient(() => {
      insertRetainedLauncherEvent(store.db, {
        hrcSeq: 11,
        text: 'OLD-REPLY',
        evidenceOrigin: null,
      })
    })
    const launcher = createRealLauncher({
      hrcDbPath: store.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 100,
      createClient: () => client.client,
    })
    try {
      await launcher({
        ...retainedLauncherInput(runStore, acpRun.runId),
        waitForCompletion: true,
        onEvent: async (event) => seen.push(event),
      })
      expect(JSON.stringify(seen)).toContain('OLD-REPLY')
    } finally {
      store.db.close()
      rmSync(store.fixtureDir, { recursive: true, force: true })
    }
  })

  test('schema change between detection and select during the fallback wait never leaks retained rows', async () => {
    const store = createRetainedLauncherStore()
    store.db.exec('PRAGMA journal_mode = WAL')
    insertOrdinaryLauncherEvent(store.db, { hrcSeq: 5, text: 'LIVE-BASELINE' })
    const writer = new Database(store.hrcDbPath)
    writer.exec('PRAGMA journal_mode = WAL')
    const runStore = new InMemoryRunStore()
    const acpRun = retainedAcpRun(runStore)
    const seen: unknown[] = []
    let detectionPatch: ReturnType<typeof patchSchemaDetection> | undefined
    const client = retainedLauncherClient(() => {
      detectionPatch = patchSchemaDetection(() => {
        writer.exec(
          "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
        )
        insertRetainedLauncherEvent(writer, {
          hrcSeq: 9,
          text: 'OLD-REPLY',
          evidenceOrigin: 'retained',
        })
      })
    })
    const launcher = createRealLauncher({
      hrcDbPath: store.hrcDbPath,
      pollIntervalMs: 2,
      watchTimeoutMs: 50,
      createClient: () => client.client,
    })

    try {
      await expect(
        launcher({
          ...retainedLauncherInput(runStore, acpRun.runId),
          waitForCompletion: true,
          onEvent: async (event) => seen.push(event),
        })
      ).rejects.toThrow('did not produce an assistant reply event')
      expect(detectionPatch?.injected()).toBe(true)
      expect(JSON.stringify(seen)).not.toContain('OLD-REPLY')
      expect(
        readAssistantMessageAfterSeq({
          hrcDbPath: store.hrcDbPath,
          hostSessionId: 'hsid-retained-launcher',
          sessionRef: retainedLauncherInput(runStore, acpRun.runId).sessionRef,
          afterHrcSeq: 5,
        })
      ).toBeUndefined()
    } finally {
      detectionPatch?.restore()
      writer.close()
      store.db.close()
      rmSync(store.fixtureDir, { recursive: true, force: true })
    }
  })

  for (const control of [
    { id: 'retained', origin: 'retained' as const, expectedSeq: 5, replayed: false },
    { id: 'C', origin: null, expectedSeq: 9, replayed: false },
    { id: "C'", origin: null, expectedSeq: 9, replayed: true },
  ]) {
    test(`launch baseline afterHrcSeq skips retained rows but counts ordinary and replayed rows (${control.id} row)`, async () => {
      const store = createRetainedLauncherStore({ evidenceColumn: true })
      insertRetainedLauncherEvent(store.db, {
        hrcSeq: 5,
        text: 'LIVE-BASELINE',
        evidenceOrigin: null,
      })
      insertRetainedLauncherEvent(store.db, {
        hrcSeq: 9,
        text: 'HISTORICAL-BASELINE',
        evidenceOrigin: control.origin,
        replayed: control.replayed,
      })
      const runStore = new InMemoryRunStore()
      const acpRun = retainedAcpRun(runStore)
      const client = retainedLauncherClient()
      const launcher = createRealLauncher({
        hrcDbPath: store.hrcDbPath,
        createClient: () => client.client,
      })
      try {
        await launcher({
          ...retainedLauncherInput(runStore, acpRun.runId),
          waitForCompletion: false,
        })
        expect(runStore.getRun(acpRun.runId)?.afterHrcSeq).toBe(control.expectedSeq)
      } finally {
        store.db.close()
        rmSync(store.fixtureDir, { recursive: true, force: true })
      }
    })
  }

  test('schema change between detection and select at launch keeps the baseline at the last ordinary row', async () => {
    const store = createRetainedLauncherStore()
    store.db.exec('PRAGMA journal_mode = WAL')
    insertOrdinaryLauncherEvent(store.db, { hrcSeq: 5, text: 'LIVE-BASELINE' })
    const writer = new Database(store.hrcDbPath)
    writer.exec('PRAGMA journal_mode = WAL')
    const detectionPatch = patchSchemaDetection(() => {
      writer.exec(
        "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
      )
      insertRetainedLauncherEvent(writer, {
        hrcSeq: 9,
        text: 'HISTORICAL-BASELINE',
        evidenceOrigin: 'retained',
      })
    })
    const runStore = new InMemoryRunStore()
    const firstRun = retainedAcpRun(runStore)
    const launcher = createRealLauncher({
      hrcDbPath: store.hrcDbPath,
      createClient: () => retainedLauncherClient().client,
    })

    try {
      await launcher({
        ...retainedLauncherInput(runStore, firstRun.runId),
        waitForCompletion: false,
      })
      expect(detectionPatch.injected()).toBe(true)
      expect(runStore.getRun(firstRun.runId)?.afterHrcSeq).toBe(5)

      const followUpRun = retainedAcpRun(runStore)
      await launcher({
        ...retainedLauncherInput(runStore, followUpRun.runId),
        waitForCompletion: false,
      })
      expect(runStore.getRun(followUpRun.runId)?.afterHrcSeq).toBe(5)
    } finally {
      detectionPatch.restore()
      writer.close()
      store.db.close()
      rmSync(store.fixtureDir, { recursive: true, force: true })
    }
  })

  // The corrupt-file row has no message pin: today a corrupt store fails open in
  // the live-tmux lookup and the launcher reaches client.dispatchTurn, which the
  // fake lacks (TypeError). Suspected product bug, held for the owner (T-11957).
  const EXPECTED_STORE_FAULT: Record<
    'missing' | 'without-hrc-seq' | 'corrupt',
    string | undefined
  > = {
    missing: 'hrc_events schema unrecognized: table missing',
    'without-hrc-seq': 'hrc_events schema unrecognized: hrc_seq column missing',
    corrupt: undefined,
  }
  for (const broken of ['missing', 'without-hrc-seq', 'corrupt'] as const) {
    test(`T-Q1a rejects before delivery when the HRC store is ${broken}`, async () => {
      const store =
        broken === 'corrupt'
          ? (() => {
              const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-corrupt-'))
              const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
              writeFileSync(hrcDbPath, 'not a sqlite database')
              return { db: undefined, hrcDbPath, fixtureDir }
            })()
          : createRetainedLauncherStore({
              evidenceColumn: true,
              hrcEventsShape: broken === 'missing' ? 'missing' : 'without-hrc-seq',
            })
      const runStore = new InMemoryRunStore()
      const acpRun = retainedAcpRun(runStore)
      const client = retainedLauncherClient()
      const launcher = createRealLauncher({
        hrcDbPath: store.hrcDbPath,
        createClient: () => client.client,
      })
      try {
        const error = await launcher({
          ...retainedLauncherInput(runStore, acpRun.runId),
          waitForCompletion: false,
        }).catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(Error)
        const expectedFault = EXPECTED_STORE_FAULT[broken]
        if (expectedFault !== undefined) {
          expect((error as Error).message).toBe(expectedFault)
        }
        expect(client.calls()).toBe(0)
        const run = runStore.getRun(acpRun.runId)
        expect(run?.status).toBe('pending')
        expect(run?.afterHrcSeq).toBeUndefined()
      } finally {
        store.db?.close()
        rmSync(store.fixtureDir, { recursive: true, force: true })
      }
    })
  }

  test('empty recognized hrc_events table launches with baseline 0', async () => {
    const store = createRetainedLauncherStore({ evidenceColumn: true })
    const runStore = new InMemoryRunStore()
    const acpRun = retainedAcpRun(runStore)
    const client = retainedLauncherClient()
    const launcher = createRealLauncher({
      hrcDbPath: store.hrcDbPath,
      createClient: () => client.client,
    })
    try {
      await launcher({
        ...retainedLauncherInput(runStore, acpRun.runId),
        waitForCompletion: false,
      })
      expect(client.calls()).toBe(2)
      expect(runStore.getRun(acpRun.runId)).toMatchObject({
        afterHrcSeq: 0,
        status: 'running',
      })
    } finally {
      store.db.close()
      rmSync(store.fixtureDir, { recursive: true, force: true })
    }
  })
})
