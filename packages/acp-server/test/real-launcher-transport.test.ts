import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { type RealLauncherClient, createRealLauncher } from '../src/real-launcher.js'
import { createHrcRouteFake } from './fixtures/hrc-route-fake.js'
import {
  createLauncherEventTable,
  createLauncherRunTables,
  createLauncherRuntimeTables,
} from './fixtures/launcher-schema.js'

describe('real launcher transport', () => {
  test('uses live tmux runtime as the default transport for interface turns', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-tmux-db-'))
    const hrcFixture = join(fixtureDir, 'hrc.sqlite')
    const db = new Database(hrcFixture)
    createLauncherRuntimeTables(db)
    createLauncherEventTable(db, 'session')
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
    db.run(
      `INSERT INTO hrc_events (host_session_id, scope_ref, lane_ref, event_kind, payload_json)
        VALUES (?, ?, ?, ?, ?)`,
      'hsid-discord',
      'agent:cody:project:agent-spaces:task:discord',
      'main',
      'turn.message',
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: 'old response' },
      })
    )

    const calls: string[] = []
    const seenEvents: unknown[] = []
    const launcher = createRealLauncher({
      hrc: createHrcRouteFake(hrcFixture),
      pollIntervalMs: 1,
      watchTimeoutMs: 250,
      createClient: () =>
        ({
          resolveSession: async (input: unknown) => {
            calls.push('resolveSession')
            expect(input).toEqual({
              sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main',
              runtimeIntent: {
                placement: {
                  agentRoot: '/tmp/cody',
                  runMode: 'task',
                  bundle: { kind: 'compose', compose: [] },
                  dryRun: false,
                },
                harness: {
                  provider: 'openai',
                  interactive: true,
                },
                execution: {
                  preferredMode: 'interactive',
                },
                initialPrompt: 'What is 2+2?',
              },
              create: true,
            })
            return {
              found: true,
              hostSessionId: 'hsid-discord',
              generation: 1,
            }
          },
          dispatchTurn: async () => {
            throw new Error('dispatchTurn should not be called when live tmux exists')
          },
          deliverLiteralBySelector: async (input: unknown) => {
            calls.push('deliverLiteralBySelector')
            if (calls.filter((call) => call === 'deliverLiteralBySelector').length === 1) {
              expect(input).toEqual({
                selector: {
                  sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main',
                },
                text: 'What is 2+2?',
                enter: false,
                fences: {
                  expectedHostSessionId: 'hsid-discord',
                  expectedGeneration: 1,
                },
              })
            } else {
              expect(input).toEqual({
                selector: {
                  sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main',
                },
                text: '',
                enter: true,
                fences: {
                  expectedHostSessionId: 'hsid-discord',
                  expectedGeneration: 1,
                },
              })
              db.run(
                `INSERT INTO hrc_events (host_session_id, scope_ref, lane_ref, event_kind, payload_json)
                  VALUES (?, ?, ?, ?, ?)`,
                'hsid-discord',
                'agent:cody:project:agent-spaces:task:discord',
                'main',
                'turn.message',
                JSON.stringify({
                  type: 'message_end',
                  message: { role: 'assistant', content: '4' },
                })
              )
            }
            return {
              delivered: true,
              sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main',
              hostSessionId: 'hsid-discord',
              generation: 1,
              runtimeId: 'rt-tmux',
            }
          },
        }) as unknown as any,
    })

    try {
      const result = await launcher({
        onEvent: async (event) => {
          seenEvents.push(event)
        },
        sessionRef: {
          scopeRef: 'agent:cody:project:agent-spaces:task:discord',
          laneRef: 'main',
        },
        intent: {
          placement: {
            agentRoot: '/tmp/cody',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: {
            provider: 'openai',
            interactive: false,
          },
          initialPrompt: 'What is 2+2?',
        },
      })

      expect(result).toEqual({
        runId: 'hsid-discord',
        sessionId: 'hsid-discord',
        hostSessionId: 'hsid-discord',
        runtimeId: 'rt-tmux',
        launchId: undefined,
        generation: 1,
      })
      expect(calls).toEqual([
        'resolveSession',
        'deliverLiteralBySelector',
        'deliverLiteralBySelector',
      ])
      expect(seenEvents).toEqual([
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '4' }],
          },
        },
      ])
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  // T-12046 §6: an hrcpty seat's runtime transport is 'hrcpty'. ACP's direct
  // literal path is a pre-broker tmux mechanism and is not ported, so a live
  // hrcpty runtime must not be matched and the turn goes over broker dispatchTurn.
  test('a live hrcpty runtime takes broker dispatchTurn, never the tmux literal path', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-hrcpty-db-'))
    const hrcFixture = join(fixtureDir, 'hrc.sqlite')
    const db = new Database(hrcFixture)
    createLauncherRuntimeTables(db)
    createLauncherRunTables(db)
    createLauncherEventTable(db, 'run')
    const sessionRef = {
      scopeRef: 'agent:clod:project:agent-control-plane:task:T-12054',
      laneRef: 'main' as const,
    }
    db.run(
      `INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at)
        VALUES (?, ?, ?, ?)`,
      sessionRef.scopeRef,
      'main',
      'hsid-hrcpty',
      '2026-10-29T17:00:00.000Z'
    )
    // The row rusthrc writes for an hrcpty seat (T-12049): transport hrcpty, no tmux_json.
    db.run(
      `INSERT INTO runtimes (runtime_id, host_session_id, transport, status, tmux_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      'rt-hrcpty',
      'hsid-hrcpty',
      'hrcpty',
      'ready',
      null,
      '2026-10-29T17:00:01.000Z'
    )

    const calls: string[] = []
    const runStore = new InMemoryRunStore()
    const acpRun = runStore.createRun({ sessionRef, status: 'pending' })
    const client: RealLauncherClient = {
      ensureTarget: async () => {
        throw new Error('an hrcpty seat launch must not first-birth')
      },
      resolveSession: async () => {
        calls.push('resolveSession')
        return {
          found: true,
          hostSessionId: 'hsid-hrcpty',
          generation: 1,
          created: false,
          session: {
            hostSessionId: 'hsid-hrcpty',
            scopeRef: sessionRef.scopeRef,
            laneRef: 'main',
            generation: 1,
            status: 'active',
            createdAt: '2026-10-29T17:00:00.000Z',
            updatedAt: '2026-10-29T17:00:00.000Z',
          },
        }
      },
      deliverLiteralBySelector: async () => {
        throw new Error('an hrcpty seat must not take the tmux literal path')
      },
      dispatchTurn: async (input) => {
        calls.push('dispatchTurn')
        expect(input).toMatchObject({ hostSessionId: 'hsid-hrcpty', prompt: 'hello hrcpty' })
        db.run(
          'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
          'run-hrcpty',
          'completed'
        )
        return {
          runId: 'run-hrcpty',
          hostSessionId: 'hsid-hrcpty',
          generation: 1,
          runtimeId: 'rt-hrcpty',
          // hrcpty runs are broker-driven; HRC keeps the run row 'headless'.
          transport: 'headless',
          stage: 'terminal',
          status: 'completed',
          replayed: false,
          supportsInFlightInput: true,
          observation: {},
        }
      },
    }
    const launcher = createRealLauncher({
      hrc: createHrcRouteFake(hrcFixture),
      pollIntervalMs: 1,
      createClient: () => client,
    })

    try {
      const result = await launcher({
        sessionRef,
        intent: {
          placement: {
            agentRoot: '/tmp/clod',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: { provider: 'anthropic', interactive: true },
          initialPrompt: 'hello hrcpty',
        },
        acpRunId: acpRun.runId,
        runStore,
      })

      expect(calls).toEqual(['resolveSession', 'dispatchTurn'])
      expect(result).toMatchObject({ runId: 'run-hrcpty', runtimeId: 'rt-hrcpty' })
      expect(runStore.getRun(acpRun.runId)).toMatchObject({
        status: 'completed',
        hrcRunId: 'run-hrcpty',
        runtimeId: 'rt-hrcpty',
        transport: 'headless',
      })
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('persists the exact HRC run returned by broker literal dispatch', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-tmux-correlation-'))
    const hrcFixture = join(fixtureDir, 'hrc.sqlite')
    const db = new Database(hrcFixture)
    createLauncherRuntimeTables(db)
    createLauncherEventTable(db, 'session')
    db.run(
      `INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at)
        VALUES (?, ?, ?, ?)`,
      'agent:cody:project:agent-spaces:task:discord-queued',
      'main',
      'hsid-discord-queued',
      '2026-08-16T07:07:54.000Z'
    )
    db.run(
      `INSERT INTO runtimes (runtime_id, host_session_id, transport, status, tmux_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      'rt-tmux-queued',
      'hsid-discord-queued',
      'tmux',
      'idle',
      '{"paneId":"%1"}',
      '2026-08-16T07:07:54.000Z'
    )

    const sessionRef = {
      scopeRef: 'agent:cody:project:agent-spaces:task:discord-queued',
      laneRef: 'main' as const,
    }
    const runStore = new InMemoryRunStore()
    const acpRun = runStore.createRun({ sessionRef, status: 'pending' })
    let deliveryCount = 0
    const launcher = createRealLauncher({
      hrc: createHrcRouteFake(hrcFixture),
      createClient: () =>
        ({
          resolveSession: async () => ({
            found: true,
            hostSessionId: 'hsid-discord-queued',
            generation: 1,
          }),
          deliverLiteralBySelector: async () => {
            deliveryCount += 1
            return {
              delivered: true,
              sessionRef: `${sessionRef.scopeRef}/lane:main`,
              hostSessionId: 'hsid-discord-queued',
              generation: 1,
              runtimeId: 'rt-tmux-queued',
              ...(deliveryCount === 2
                ? { runId: 'hrc-run-discord-queued-b', status: 'started' }
                : {}),
            }
          },
        }) as unknown as any,
    })

    try {
      const result = await launcher({
        sessionRef,
        intent: {
          placement: {
            agentRoot: '/tmp/cody',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: { provider: 'openai', interactive: true },
          initialPrompt: 'queued message B',
        },
        acpRunId: acpRun.runId,
        runStore,
        waitForCompletion: false,
      })

      expect(result.runId).toBe('hrc-run-discord-queued-b')
      expect(runStore.getRun(acpRun.runId)).toMatchObject({
        status: 'running',
        hrcRunId: 'hrc-run-discord-queued-b',
        hostSessionId: 'hsid-discord-queued',
        runtimeId: 'rt-tmux-queued',
        transport: 'tmux',
      })
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})
