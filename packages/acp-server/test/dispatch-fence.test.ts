import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcConflictError, HrcErrorCode } from 'hrc-core'

import { InMemoryInputAttemptStore } from '../src/domain/input-attempt-store.js'
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
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-dispatch-fence-headless-'))
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

function createTmuxHrcDb(): { db: Database; hrcDbPath: string; cleanup(): void } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-dispatch-fence-tmux-'))
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)

  db.exec(`
    CREATE TABLE continuities (
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      active_host_session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_ref, lane_ref)
    );
    CREATE TABLE runtimes (
      runtime_id TEXT PRIMARY KEY,
      host_session_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      tmux_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      host_session_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `)
  db.run(
    `INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at)
      VALUES (?, ?, ?, ?)`,
    'agent:cody:project:agent-spaces:task:discord',
    'main',
    'hsid-discord',
    '2026-04-21T17:00:00.000Z'
  )
  db.run(
    `INSERT INTO runtimes (runtime_id, host_session_id, transport, status, tmux_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    'rt-tmux',
    'hsid-discord',
    'tmux',
    'busy',
    '{"paneId":"%1"}',
    '2026-04-21T17:00:01.000Z'
  )

  return {
    db,
    hrcDbPath,
    cleanup() {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    },
  }
}

class FollowLatestInputAttemptStore extends InMemoryInputAttemptStore {
  override createAttempt(input: Parameters<InMemoryInputAttemptStore['createAttempt']>[0]) {
    const created = super.createAttempt(input)
    input.runStore.setDispatchFence(created.runId, { followLatest: true })
    return created
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

describe('ACP dispatch fences', () => {
  test('passes a concrete fence from resolveSession into dispatchTurn', async () => {
    const dispatchCalls: unknown[] = []
    const launcher = createRealLauncher({
      hrcDbPath: ':memory:',
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-123', generation: 4 }),
          dispatchTurn: async (input: unknown) => {
            dispatchCalls.push(input)
            return {
              runId: 'hrc-run-123',
              hostSessionId: 'hsid-123',
              generation: 4,
              runtimeId: 'rt-123',
              transport: 'headless',
              status: 'started',
              supportsInFlightInput: false,
            }
          },
        }) as unknown as any,
    })

    await launcher({
      sessionRef: {
        scopeRef: 'agent:rex:project:agent-spaces',
        laneRef: 'main',
      },
      intent: {
        placement: {
          agentRoot: '/tmp/rex',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        initialPrompt: 'remember chartreuse',
      },
    })

    expect(dispatchCalls[0]).toEqual(
      expect.objectContaining({
        hostSessionId: 'hsid-123',
        prompt: 'remember chartreuse',
        fences: {
          expectedHostSessionId: 'hsid-123',
          expectedGeneration: 4,
        },
      })
    )
  })

  test('records a stale fence rejection on the ACP run when dispatch sees a rotated host session', async () => {
    const dispatchCalls: unknown[] = []
    const launcher = createRealLauncher({
      hrcDbPath: ':memory:',
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-old', generation: 5 }),
          dispatchTurn: async (input: unknown) => {
            dispatchCalls.push(input)
            throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'generation fence is stale', {
              expectedGeneration: 5,
              activeGeneration: 6,
            })
          },
        }) as unknown as any,
    })

    await withWiredServer(
      async (fixture) => {
        addInterfaceBinding(fixture)

        const response = await postInterfaceMessage(fixture)
        const [storedRun] = fixture.runStore.listRuns()

        expect(response.status).toBe(500)
        expect(storedRun).toMatchObject({
          dispatchFence: {
            expectedHostSessionId: 'hsid-old',
            expectedGeneration: 5,
          },
          errorCode: 'stale_context',
        })
        expect(dispatchCalls[0]).toEqual(
          expect.objectContaining({
            fences: {
              expectedHostSessionId: 'hsid-old',
              expectedGeneration: 5,
            },
          })
        )
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
  })

  test('sends fences on deliverLiteralBySelector for live tmux selector dispatches', async () => {
    const hrc = createTmuxHrcDb()
    const resolveCalls: unknown[] = []
    const deliverCalls: unknown[] = []
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      createClient: () =>
        ({
          resolveSession: async (input: unknown) => {
            resolveCalls.push(input)
            return { hostSessionId: 'hsid-discord', generation: 9 }
          },
          dispatchTurn: async () => {
            throw new Error('dispatchTurn should not be called when live tmux exists')
          },
          deliverLiteralBySelector: async (input: unknown) => {
            deliverCalls.push(input)
            return {
              delivered: true,
              sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main',
              hostSessionId: 'hsid-discord',
              generation: 9,
              runtimeId: 'rt-tmux',
            }
          },
        }) as unknown as any,
    })

    try {
      await launcher({
        sessionRef: {
          scopeRef: 'agent:cody:project:agent-spaces:task:discord',
          laneRef: 'main',
        },
        intent: {
          placement: {
            agentRoot: '/tmp/cody',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
          },
          harness: {
            provider: 'openai',
            interactive: false,
          },
          initialPrompt: 'What is 2+2?',
        },
      })

      expect(resolveCalls).toHaveLength(1)
      expect(deliverCalls).toEqual([
        {
          selector: { sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main' },
          text: 'What is 2+2?',
          enter: false,
          fences: {
            expectedHostSessionId: 'hsid-discord',
            expectedGeneration: 9,
          },
        },
        {
          selector: { sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main' },
          text: '',
          enter: true,
          fences: {
            expectedHostSessionId: 'hsid-discord',
            expectedGeneration: 9,
          },
        },
      ])
    } finally {
      hrc.cleanup()
    }
  })

  test('uses followLatest=true instead of concrete session fences when explicitly opted in', async () => {
    const hrc = createHeadlessHrcDb()
    const dispatchCalls: unknown[] = []
    const launcher = createRealLauncher({
      hrcDbPath: hrc.hrcDbPath,
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async () => ({ hostSessionId: 'hsid-follow', generation: 12 }),
          dispatchTurn: async (input: unknown) => {
            dispatchCalls.push(input)
            const fences =
              typeof input === 'object' && input !== null && 'fences' in input
                ? (input as { fences?: { followLatest?: boolean | undefined } }).fences
                : undefined

            if (fences?.followLatest !== true) {
              throw new HrcConflictError(
                HrcErrorCode.STALE_CONTEXT,
                'host session fence is stale',
                {
                  expectedHostSessionId: 'hsid-follow',
                  activeHostSessionId: 'hsid-rotated',
                }
              )
            }

            hrc.db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
              'hrc-run-follow',
              'completed'
            )
            hrc.db.run(
              'INSERT INTO events (run_id, event_kind, event_json) VALUES (?, ?, ?)',
              'hrc-run-follow',
              'message_end',
              JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Used followLatest.' }],
                },
              })
            )

            return {
              runId: 'hrc-run-follow',
              hostSessionId: 'hsid-rotated',
              generation: 13,
              runtimeId: 'rt-follow',
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

          expect(response.status).toBe(201)
          expect(dispatchCalls[0]).toEqual(
            expect.objectContaining({
              fences: {
                followLatest: true,
              },
            })
          )
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
          inputAttemptStore: new FollowLatestInputAttemptStore(),
          launchRoleScopedRun: launcher,
        }
      )
    } finally {
      hrc.cleanup()
    }
  })
})
