import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { createRealLauncher } from '../src/real-launcher.js'
import { createHrcRouteFake } from './fixtures/hrc-route-fake.js'
import { createLauncherRuntimeTables } from './fixtures/launcher-schema.js'

type RetainedLauncherStore = {
  db: Database
  hrcFixture: string
  fixtureDir: string
}

function createRetainedLauncherStore(
  input: {
    evidenceColumn?: boolean | undefined
  } = {}
): RetainedLauncherStore {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-retained-'))
  const hrcFixture = join(fixtureDir, 'hrc-fixture.sqlite')
  const db = new Database(hrcFixture)
  createLauncherRuntimeTables(db)
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
  return { db, hrcFixture, fixtureDir }
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
      hrc: createHrcRouteFake(store.hrcFixture),
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
      hrc: createHrcRouteFake(store.hrcFixture),
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

  for (const control of [
    { id: 'retained', origin: 'retained' as const, expectedSeq: 5, replayed: false },
    { id: 'C', origin: null, expectedSeq: 9, replayed: false },
    { id: "C'", origin: null, expectedSeq: 9, replayed: true },
  ]) {
    for (const ignoreNewSelectors of [false, true])
      test(`launch baseline afterHrcSeq skips retained rows but counts ordinary and replayed rows (${control.id} row, ignoreNewSelectors=${ignoreNewSelectors})`, async () => {
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
          hrc: createHrcRouteFake(store.hrcFixture, { ignoreNewSelectors }),
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

  test('a failed HRC baseline read rejects before delivery and leaves the run pending', async () => {
    const store = createRetainedLauncherStore({ evidenceColumn: true })
    const runStore = new InMemoryRunStore()
    const acpRun = retainedAcpRun(runStore)
    const client = retainedLauncherClient()
    const launcher = createRealLauncher({
      hrc: createHrcRouteFake(store.hrcFixture, {
        fail: (call) =>
          call.route === 'events.tail' ? new Error('HRC events tail unavailable') : undefined,
      }),
      createClient: () => client.client,
    })
    try {
      const error = await launcher({
        ...retainedLauncherInput(runStore, acpRun.runId),
        waitForCompletion: false,
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('HRC events tail unavailable')
      expect(client.calls()).toBe(0)
      const run = runStore.getRun(acpRun.runId)
      expect(run?.status).toBe('pending')
      expect(run?.afterHrcSeq).toBeUndefined()
    } finally {
      store.db.close()
      rmSync(store.fixtureDir, { recursive: true, force: true })
    }
  })

  test('empty recognized hrc_events table launches with baseline 0', async () => {
    const store = createRetainedLauncherStore({ evidenceColumn: true })
    const runStore = new InMemoryRunStore()
    const acpRun = retainedAcpRun(runStore)
    const client = retainedLauncherClient()
    const launcher = createRealLauncher({
      hrc: createHrcRouteFake(store.hrcFixture),
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
