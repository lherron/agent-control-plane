import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      error_message TEXT
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
            bundle: { kind: 'agent-default' },
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

          expect(response.status).toBe(500)
          expect(storedRun).toMatchObject({
            hrcRunId: 'hrc-run-failed',
            hostSessionId: 'hsid-failed',
            generation: 11,
            runtimeId: 'rt-failed',
            transport: 'headless',
            errorCode: 'runtime_unavailable',
            errorMessage: 'sandbox missing',
          })
        },
        {
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })

  test('correlates the returned ACP runId with the HRC run launched by interface messages', async () => {
    const hrc = createHeadlessHrcDb()
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
            bundle: { kind: 'agent-default' },
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
