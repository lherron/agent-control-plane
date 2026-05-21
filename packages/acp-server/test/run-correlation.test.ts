import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInterfaceRunDispatcher } from '../src/integration/interface-run-dispatcher.js'
import { createRealLauncher } from '../src/real-launcher.js'

import { type WiredServerFixture, withWiredServer } from './fixtures/wired-server.js'

function addInterfaceBinding(fixture: WiredServerFixture): void {
  fixture.interfaceStore.bindings.create({
    bindingId: 'ifb_123',
    gatewayId: 'discord_prod',
    conversationRef: 'channel:123',
    scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
    laneRef: 'main',
    projectId: fixture.seed.projectId,
    status: 'active',
    createdAt: '2026-04-20T15:00:00.000Z',
    updatedAt: '2026-04-20T15:00:00.000Z',
  })
}

function createHeadlessHrcDb(): { db: Database; hrcDbPath: string; cleanup(): void } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-run-correlation-'))
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)

  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      host_session_id TEXT,
      accepted_at TEXT
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `)

  return {
    db,
    hrcDbPath,
    cleanup() {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    },
  }
}

function createRunScopedHrcEventsTable(db: Database): void {
  db.exec(`
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `)
}

async function postInterfaceMessage(fixture: WiredServerFixture): Promise<Response> {
  return fixture.request({
    method: 'POST',
    path: '/v1/interface/messages',
    body: {
      source: {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        messageRef: 'discord:message:123',
        authorRef: 'discord:user:999',
      },
      content: 'Please summarize the status of T-01163.',
    },
  })
}

describe('ACP run correlation', () => {
  test('stores HRC correlation fields on the ACP run after dispatch', async () => {
    const hrc = createHeadlessHrcDb()
    createRunScopedHrcEventsTable(hrc.db)
    const dispatchCalls: unknown[] = []
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-123', generation: 7 }),
          dispatchTurn: async (input: unknown) => {
            dispatchCalls.push(input)
            hrc.db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
              'hrc-run-123',
              'completed'
            )
            hrc.db.run(
              'INSERT INTO events (run_id, event_kind, event_json) VALUES (?, ?, ?)',
              'hrc-run-123',
              'message_end',
              JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'All green.' }],
                },
              })
            )
            hrc.db.run(
              'INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)',
              'hrc-run-123',
              'turn.completed',
              JSON.stringify({ finalOutput: 'All green.' })
            )

            return {
              runId: 'hrc-run-123',
              hostSessionId: 'hsid-123',
              generation: 7,
              runtimeId: 'rt-123',
              transport: 'headless',
              status: 'completed',
              supportsInFlightInput: false,
            }
          },
        }) as unknown as any,
    })

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ inputAttemptId: string; runId: string }>(response)
          const storedRun = fixture.runStore.getRun(payload.runId)

          expect(response.status).toBe(201)
          expect(dispatchCalls).toHaveLength(1)
          expect(storedRun).toMatchObject({
            runId: payload.runId,
            hrcRunId: 'hrc-run-123',
            hostSessionId: 'hsid-123',
            generation: 7,
            runtimeId: 'rt-123',
            transport: 'headless',
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('persists errorCode and errorMessage from failed HRC runs on the ACP run', async () => {
    const hrc = createHeadlessHrcDb()
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-failed', generation: 11 }),
          dispatchTurn: async () => {
            hrc.db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, ?, ?)',
              'hrc-run-failed',
              'failed',
              'runtime_unavailable',
              'sandbox missing'
            )

            return {
              runId: 'hrc-run-failed',
              hostSessionId: 'hsid-failed',
              generation: 11,
              runtimeId: 'rt-failed',
              transport: 'headless',
              status: 'started',
              supportsInFlightInput: false,
            }
          },
        }) as unknown as any,
    })

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const [storedRun] = fixture.runStore.listRuns()

          expect(response.status).toBe(201)
          expect(storedRun).toMatchObject({
            hrcRunId: 'hrc-run-failed',
            hostSessionId: 'hsid-failed',
            generation: 11,
            runtimeId: 'rt-failed',
            transport: 'headless',
          })

          const dispatcher = createInterfaceRunDispatcher({
            runStore: fixture.runStore,
            interfaceStore: fixture.interfaceStore,
            conversationStore: fixture.conversationStore,
            hrcDbPath: hrc.hrcDbPath,
            config: { intervalMs: 1, staleTimeoutMs: 1_000 },
          })
          await dispatcher.runOnce()

          expect(fixture.runStore.getRun(storedRun?.runId ?? '')).toMatchObject({
            status: 'failed',
            errorCode: 'turn_failed',
            errorMessage: 'sandbox missing',
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('dispatcher fails stale pending interface runs with no HRC correlation', async () => {
    const hrc = createHeadlessHrcDb()

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ runId: string }>(response)
          expect(response.status).toBe(201)
          const pendingRun = fixture.runStore.getRun(payload.runId)
          expect(pendingRun?.status).toBe('pending')
          expect(pendingRun?.hrcRunId).toBeUndefined()
          expect(pendingRun?.hostSessionId).toBeUndefined()

          await Bun.sleep(2)
          const dispatcher = createInterfaceRunDispatcher({
            runStore: fixture.runStore,
            interfaceStore: fixture.interfaceStore,
            conversationStore: fixture.conversationStore,
            hrcDbPath: hrc.hrcDbPath,
            config: { intervalMs: 1, staleTimeoutMs: 1_000, dispatchStaleTimeoutMs: 1 },
          })
          await dispatcher.runOnce()

          expect(fixture.runStore.getRun(payload.runId)).toMatchObject({
            status: 'failed',
            errorCode: 'dispatch_timeout',
          })
          const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(delivery).toMatchObject({
            runId: payload.runId,
            bodyText: expect.stringContaining('no agent run started before dispatch timeout'),
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async () => ({
            runId: 'hrc-run-never-recorded',
            sessionId: 'session-never-recorded',
          }),
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('dispatcher does not fail stale pending runs when HRC accepted a run on the host session', async () => {
    const hrc = createHeadlessHrcDb()

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ runId: string }>(response)
          expect(response.status).toBe(201)

          const hostSessionId = 'hsid-slow-dispatch'
          fixture.runStore.updateRun(payload.runId, { hostSessionId })

          const acpRun = fixture.runStore.getRun(payload.runId)
          expect(acpRun?.status).toBe('pending')
          expect(acpRun?.hrcRunId).toBeUndefined()
          expect(acpRun?.hostSessionId).toBe(hostSessionId)

          const acceptedAt = new Date(
            new Date(acpRun?.createdAt ?? '').getTime() + 100
          ).toISOString()
          hrc.db.run(
            'INSERT INTO runs (run_id, status, host_session_id, accepted_at) VALUES (?, ?, ?, ?)',
            'hrc-run-in-flight',
            'running',
            hostSessionId,
            acceptedAt
          )

          await Bun.sleep(2)
          const dispatcher = createInterfaceRunDispatcher({
            runStore: fixture.runStore,
            interfaceStore: fixture.interfaceStore,
            conversationStore: fixture.conversationStore,
            hrcDbPath: hrc.hrcDbPath,
            config: { intervalMs: 1, staleTimeoutMs: 1_000, dispatchStaleTimeoutMs: 1 },
          })
          await dispatcher.runOnce()

          expect(fixture.runStore.getRun(payload.runId)).toMatchObject({
            status: 'pending',
          })
          const queued = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(queued.some((delivery) => delivery.bodyText.includes('dispatch timeout'))).toBe(
            false
          )
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async () => ({
            runId: 'hrc-run-pending-correlation',
            sessionId: 'session-pending-correlation',
          }),
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('correlates the returned ACP runId with the HRC run launched by interface messages', async () => {
    const hrc = createHeadlessHrcDb()
    createRunScopedHrcEventsTable(hrc.db)
    const dispatchCalls: Array<Record<string, unknown>> = []
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-456', generation: 13 }),
          dispatchTurn: async (input: unknown) => {
            dispatchCalls.push(input as Record<string, unknown>)
            hrc.db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
              'hrc-run-456',
              'completed'
            )
            hrc.db.run(
              'INSERT INTO events (run_id, event_kind, event_json) VALUES (?, ?, ?)',
              'hrc-run-456',
              'message_end',
              JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Correlated.' }],
                },
              })
            )
            hrc.db.run(
              'INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)',
              'hrc-run-456',
              'turn.completed',
              JSON.stringify({ finalOutput: 'Correlated.' })
            )

            return {
              runId: 'hrc-run-456',
              hostSessionId: 'hsid-456',
              generation: 13,
              runtimeId: 'rt-456',
              transport: 'headless',
              status: 'completed',
              supportsInFlightInput: false,
            }
          },
        }) as unknown as any,
    })

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ inputAttemptId: string; runId: string }>(response)
          const storedRun = fixture.runStore.getRun(payload.runId)

          expect(response.status).toBe(201)
          expect(payload.runId).not.toBe('hrc-run-456')
          expect(dispatchCalls[0]).not.toHaveProperty('runId')
          expect(storedRun).toMatchObject({
            runId: payload.runId,
            hrcRunId: 'hrc-run-456',
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('pending interface runs with partial HRC correlation do not leak old session content', async () => {
    const hrc = createHeadlessHrcDb()
    hrc.db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const sharedScopeRef = `agent:curly:project:${fixture.seed.projectId}`
          const sharedLaneRef = 'main'
          const sharedHostSessionId = 'hsid-shared-session'

          // Seed an OLD assistant message in this host session — represents leftover
          // content from a prior run that previously leaked into new deliveries.
          hrc.db.run(
            `INSERT INTO hrc_events (host_session_id, scope_ref, lane_ref, run_id, event_kind, payload_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
            sharedHostSessionId,
            sharedScopeRef,
            sharedLaneRef,
            'old-hrc-run-id',
            'turn.message',
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'Old preamble from a prior run that must NOT leak.' },
                ],
              },
            })
          )

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ runId: string }>(response)
          expect(response.status).toBe(201)

          // Simulate the partial-correlation pending window real-launcher passes through:
          // hostSessionId is set after resolveSession but before HRC accepts the turn,
          // so hrcRunId/runtimeId/afterHrcSeq are still undefined.
          fixture.runStore.updateRun(payload.runId, {
            status: 'pending',
            hostSessionId: sharedHostSessionId,
          })
          const partialRun = fixture.runStore.getRun(payload.runId)
          expect(partialRun?.status).toBe('pending')
          expect(partialRun?.hostSessionId).toBe(sharedHostSessionId)
          expect(partialRun?.hrcRunId).toBeUndefined()

          const dispatcher = createInterfaceRunDispatcher({
            runStore: fixture.runStore,
            interfaceStore: fixture.interfaceStore,
            conversationStore: fixture.conversationStore,
            hrcDbPath: hrc.hrcDbPath,
            config: { intervalMs: 1, staleTimeoutMs: 60_000, dispatchStaleTimeoutMs: 60_000 },
          })
          await dispatcher.runOnce()

          // Run must remain pending (not stale yet) and NO delivery should be enqueued
          // with the old session content.
          const stillPendingRun = fixture.runStore.getRun(payload.runId)
          expect(stillPendingRun?.status).toBe('pending')
          expect(
            fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          ).toHaveLength(0)

          // When the run progresses to completed with hrcRunId set, the dispatcher should
          // deliver the correct content from the new run's events, not the old leakage.
          const correctHrcRunId = 'hrc-run-new'
          hrc.db.run(
            'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
            correctHrcRunId,
            'completed'
          )
          hrc.db.run(
            `INSERT INTO hrc_events (host_session_id, scope_ref, lane_ref, run_id, event_kind, payload_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
            sharedHostSessionId,
            sharedScopeRef,
            sharedLaneRef,
            correctHrcRunId,
            'turn.completed',
            JSON.stringify({
              success: true,
              transport: 'headless',
              finalOutput: 'Fresh correct output for the new run.',
            })
          )
          fixture.runStore.updateRun(payload.runId, {
            status: 'completed',
            hrcRunId: correctHrcRunId,
          })

          await dispatcher.runOnce()

          const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(delivery).toMatchObject({
            runId: payload.runId,
            bodyText: 'Fresh correct output for the new run.',
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async () => ({
            runId: 'irrelevant-launcher-output',
            sessionId: 'irrelevant-launcher-output',
          }),
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('dispatcher delivers final output for completed interface runs with no delivery yet', async () => {
    const hrc = createHeadlessHrcDb()
    hrc.db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-fast', generation: 5 }),
          dispatchTurn: async () => {
            hrc.db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
              'hrc-run-fast',
              'completed'
            )
            hrc.db.run(
              'INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)',
              'hrc-run-fast',
              'turn.completed',
              JSON.stringify({
                success: true,
                transport: 'headless',
                finalOutput: 'Fast final output.',
              })
            )

            return {
              runId: 'hrc-run-fast',
              hostSessionId: 'hsid-fast',
              generation: 5,
              runtimeId: 'rt-fast',
              transport: 'headless',
              status: 'completed',
              supportsInFlightInput: false,
            }
          },
        }) as unknown as any,
    })

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ runId: string }>(response)
          expect(response.status).toBe(201)
          expect(fixture.runStore.getRun(payload.runId)?.status).toBe('completed')

          const dispatcher = createInterfaceRunDispatcher({
            runStore: fixture.runStore,
            interfaceStore: fixture.interfaceStore,
            conversationStore: fixture.conversationStore,
            hrcDbPath: hrc.hrcDbPath,
            config: { intervalMs: 1, staleTimeoutMs: 1_000 },
          })
          await dispatcher.runOnce()

          const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(delivery).toMatchObject({
            runId: payload.runId,
            bodyText: 'Fast final output.',
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('dispatcher delivers degraded outcome for completed interface runs with no assistant content', async () => {
    const hrc = createHeadlessHrcDb()
    hrc.db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-empty', generation: 5 }),
          dispatchTurn: async () => {
            hrc.db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
              'hrc-run-empty',
              'completed'
            )
            hrc.db.run(
              'INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)',
              'hrc-run-empty',
              'turn.completed',
              JSON.stringify({
                success: true,
                transport: 'headless',
                source: 'codex_app_server',
              })
            )

            return {
              runId: 'hrc-run-empty',
              hostSessionId: 'hsid-empty',
              generation: 5,
              runtimeId: 'rt-empty',
              transport: 'headless',
              status: 'completed',
              supportsInFlightInput: false,
            }
          },
        }) as unknown as any,
    })

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ runId: string }>(response)
          expect(response.status).toBe(201)

          const dispatcher = createInterfaceRunDispatcher({
            runStore: fixture.runStore,
            interfaceStore: fixture.interfaceStore,
            conversationStore: fixture.conversationStore,
            hrcDbPath: hrc.hrcDbPath,
            config: { intervalMs: 1, staleTimeoutMs: 1_000 },
          })
          await dispatcher.runOnce()

          const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(delivery).toMatchObject({
            runId: payload.runId,
            bodyText: '',
            outcome: {
              state: 'degraded',
              reason: 'no_assistant_content',
              source: 'codex_app_server',
            },
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('dispatcher prefers assistant content over degraded no-content outcome metadata', async () => {
    const hrc = createHeadlessHrcDb()
    hrc.db.exec(`
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-contradictory', generation: 6 }),
          dispatchTurn: async () => {
            hrc.db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
              'hrc-run-contradictory',
              'completed'
            )
            hrc.db.run(
              'INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)',
              'hrc-run-contradictory',
              'turn.completed',
              JSON.stringify({
                success: true,
                transport: 'headless',
                source: 'codex_app_server',
                outcome: {
                  state: 'degraded',
                  reason: 'no_assistant_content',
                  source: 'codex_app_server',
                },
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Useful assistant content.' }],
                },
                finalOutput: 'Fallback final output.',
              })
            )

            return {
              runId: 'hrc-run-contradictory',
              hostSessionId: 'hsid-contradictory',
              generation: 6,
              runtimeId: 'rt-contradictory',
              transport: 'headless',
              status: 'completed',
              supportsInFlightInput: false,
            }
          },
        }) as unknown as any,
    })

    try {
      await withWiredServer(
        async (fixture) => {
          addInterfaceBinding(fixture)

          const response = await postInterfaceMessage(fixture)
          const payload = await fixture.json<{ runId: string }>(response)
          expect(response.status).toBe(201)

          const dispatcher = createInterfaceRunDispatcher({
            runStore: fixture.runStore,
            interfaceStore: fixture.interfaceStore,
            conversationStore: fixture.conversationStore,
            hrcDbPath: hrc.hrcDbPath,
            config: { intervalMs: 1, staleTimeoutMs: 1_000 },
          })
          await dispatcher.runOnce()

          const [delivery] = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
          expect(delivery).toMatchObject({
            runId: payload.runId,
            bodyText: 'Useful assistant content.',
          })
          expect(delivery?.outcome).toBeUndefined()
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })
})
