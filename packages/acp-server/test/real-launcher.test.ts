import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcDispatchOrigin, HrcRuntimeIntent } from 'hrc-core'

import { InMemoryInputAttemptStore } from '../src/domain/input-attempt-store.js'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import {
  type RealLauncherClient,
  createRealLauncher,
  readAssistantMessageAfterSeq,
} from '../src/real-launcher.js'

async function captureDispatchOrigin(input: {
  actor: { kind: 'human' | 'agent' | 'system'; id: string }
  metadata?: Readonly<Record<string, unknown>> | undefined
}): Promise<HrcDispatchOrigin | undefined> {
  const inputAttemptStore = new InMemoryInputAttemptStore()
  const runStore = new InMemoryRunStore()
  const sessionRef = {
    scopeRef: 'agent:fettle:project:agent-control-plane:task:T-07237-origin-test',
    laneRef: 'main' as const,
  }
  const attempt = inputAttemptStore.createAttempt({
    sessionRef,
    content: 'origin test',
    actor: input.actor,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }).inputAttempt
  const acpRun = runStore.createRun({
    sessionRef,
    actor: { kind: 'system', id: 'wrong-fallback-must-not-win' },
    status: 'pending',
  })
  let origin: HrcDispatchOrigin | undefined
  const launcher = createRealLauncher({
    hrcDbPath: ':memory:',
    inputAttemptStore,
    createClient: () =>
      ({
        resolveSession: async () => ({
          found: true,
          hostSessionId: 'hsid-origin-test',
          generation: 1,
        }),
        dispatchTurn: async (request: {
          origin?: HrcDispatchOrigin | undefined
        }) => {
          origin = request.origin
          return {
            runId: 'hrc-run-origin-test',
            hostSessionId: 'hsid-origin-test',
            generation: 1,
            runtimeId: 'rt-origin-test',
            transport: 'headless',
            status: 'accepted',
          }
        },
      }) as unknown as any,
  })

  await launcher({
    sessionRef,
    intent: {
      placement: {
        agentRoot: '/tmp/fettle',
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
      },
      harness: { provider: 'openai', interactive: false },
      initialPrompt: 'origin test',
    },
    acpRunId: acpRun.runId,
    inputAttemptId: attempt.inputAttemptId,
    runStore,
    waitForCompletion: false,
  })

  return origin
}

describe('real launcher helpers', () => {
  test('threads agent origin and job-run causation from the durable input attempt', async () => {
    expect(
      await captureDispatchOrigin({
        actor: { kind: 'agent', id: 'cody' },
        metadata: {
          source: { kind: 'job', jobId: 'job_t07237', jobRunId: 'jrun_t07237' },
        },
      })
    ).toEqual({
      actor: 'agent:cody',
      kind: 'agent',
      causationRef: 'jrun_t07237',
    })
  })

  test('threads human origin without causation for non-job input', async () => {
    expect(
      await captureDispatchOrigin({
        actor: { kind: 'human', id: 'lherron' },
        metadata: { source: { kind: 'interface', gatewayId: 'discord' } },
      })
    ).toEqual({ actor: 'human:lherron', kind: 'human' })
  })

  test('missing input metadata degrades to actor-only origin without blocking dispatch', async () => {
    expect(
      await captureDispatchOrigin({
        actor: { kind: 'agent', id: 'agent:already-canonical' },
      })
    ).toEqual({ actor: 'agent:already-canonical', kind: 'agent' })
  })

  describe('first-turn timeout override passthrough', () => {
    const OVERRIDE_SCOPE = 'agent:fettle:project:agent-control-plane:task:T-07237-origin-test'

    async function captureFirstTurnTimeout(env: {
      scope?: string | undefined
      ms?: string | undefined
    }): Promise<number | undefined> {
      const priorScope = process.env['ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE']
      const priorMs = process.env['ACP_HRC_FIRST_TURN_TIMEOUT_MS']
      if (env.scope === undefined)
        Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE')
      else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE'] = env.scope
      if (env.ms === undefined) Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_MS')
      else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_MS'] = env.ms

      const inputAttemptStore = new InMemoryInputAttemptStore()
      const runStore = new InMemoryRunStore()
      const sessionRef = { scopeRef: OVERRIDE_SCOPE, laneRef: 'main' as const }
      const attempt = inputAttemptStore.createAttempt({
        sessionRef,
        content: 'timeout override test',
        actor: { kind: 'agent', id: 'mable' },
      }).inputAttempt
      const acpRun = runStore.createRun({
        sessionRef,
        actor: { kind: 'agent', id: 'mable' },
        status: 'pending',
      })
      let captured: number | undefined
      try {
        const launcher = createRealLauncher({
          hrcDbPath: ':memory:',
          inputAttemptStore,
          createClient: () =>
            ({
              resolveSession: async () => ({
                found: true,
                hostSessionId: 'hsid-timeout-test',
                generation: 1,
              }),
              dispatchTurn: async (request: {
                firstTurnTimeoutMs?: number | undefined
              }) => {
                captured = request.firstTurnTimeoutMs
                return {
                  runId: 'hrc-run-timeout-test',
                  hostSessionId: 'hsid-timeout-test',
                  generation: 1,
                  runtimeId: 'rt-timeout-test',
                  transport: 'headless',
                  status: 'accepted',
                }
              },
            }) as unknown as any,
        })
        await launcher({
          sessionRef,
          intent: {
            placement: {
              agentRoot: '/tmp/fettle',
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
            },
            harness: { provider: 'openai', interactive: false },
            initialPrompt: 'timeout override test',
          },
          acpRunId: acpRun.runId,
          inputAttemptId: attempt.inputAttemptId,
          runStore,
          waitForCompletion: false,
        })
      } finally {
        if (priorScope === undefined)
          Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE')
        else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_SCOPE'] = priorScope
        if (priorMs === undefined)
          Reflect.deleteProperty(process.env, 'ACP_HRC_FIRST_TURN_TIMEOUT_MS')
        else process.env['ACP_HRC_FIRST_TURN_TIMEOUT_MS'] = priorMs
      }
      return captured
    }

    test('passes the override only when scope matches exactly', async () => {
      expect(await captureFirstTurnTimeout({ scope: OVERRIDE_SCOPE, ms: '1000' })).toBe(1000)
    })

    test('override env for a different scope sends no firstTurnTimeoutMs', async () => {
      expect(
        await captureFirstTurnTimeout({
          scope: 'agent:smokey:project:hrc-runtime:task:bridge-echo',
          ms: '1000',
        })
      ).toBeUndefined()
    })

    test('does not pass the override when env is unset or malformed', async () => {
      expect(await captureFirstTurnTimeout({})).toBeUndefined()
      expect(await captureFirstTurnTimeout({ scope: OVERRIDE_SCOPE, ms: 'soon' })).toBeUndefined()
      expect(await captureFirstTurnTimeout({ scope: OVERRIDE_SCOPE, ms: '-5' })).toBeUndefined()
    })
  })

  test('refuses local launch for a remote-bound prompt without writing an HRC message', async () => {
    const calls: string[] = []
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:hrc-runtime:task:remote-discord',
      laneRef: 'main' as const,
    }
    const acpRun = runStore.createRun({
      sessionRef,
      status: 'pending',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_remote',
            conversationRef: 'channel:remote',
            messageRef: 'discord:message:remote',
          },
        },
      },
    })
    const launcher = createRealLauncher({
      hrcDbPath: ':memory:',
      createClient: () =>
        ({
          locateScope: async (scopeRef: string) => {
            calls.push('locateScope')
            expect(scopeRef).toBe(sessionRef.scopeRef)
            return {
              scopeRef,
              localNodeId: 'svc',
              federationConfigured: true,
              authority: {
                state: 'bound',
                source: 'registry',
                isLocal: false,
                record: { homeNodeId: 'lab', placementEpoch: 3 },
              },
            }
          },
          resolveSession: async () => {
            throw new Error('remote interface run must not resolve a local HRC session')
          },
          dispatchTurn: async () => {
            throw new Error('remote interface run must not dispatch a local HRC turn')
          },
        }) as unknown as any,
    })

    await expect(
      launcher({
        sessionRef,
        acpRunId: acpRun.runId,
        inputAttemptId: 'ia_remote',
        runStore,
        waitForCompletion: false,
        onEvent: async () => {},
        intent: {
          placement: {
            agentRoot: '/tmp/cody',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: { provider: 'openai', interactive: false },
          initialPrompt: '  remember orchid  ',
        },
      })
    ).rejects.toThrow('owned by the collaboration ledger; ACP local launch refused')

    expect(calls).toEqual(['locateScope'])
    expect(runStore.getRun(acpRun.runId)).toMatchObject({ status: 'pending' })
  })

  test('refuses to first-birth an unbound prompt scope for a non-job launch', async () => {
    const calls: string[] = []
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:scribe:project:hrc-runtime:task:e2e-t4-acp-regression',
      laneRef: 'main' as const,
    }
    const acpRun = runStore.createRun({
      sessionRef,
      status: 'pending',
      metadata: {},
    })
    const launcher = createRealLauncher({
      hrcDbPath: ':memory:',
      createClient: () =>
        ({
          locateScope: async () => {
            calls.push('locateScope')
            return {
              scopeRef: sessionRef.scopeRef,
              localNodeId: 'svc',
              federationConfigured: true,
              authority: {
                state: 'unbound',
                registry: { state: 'unbound' },
                declaredPolicy: {
                  kind: 'default_home_node',
                  homeNodeId: 'max3',
                },
              },
            }
          },
          resolveSession: async () => {
            throw new Error('unbound prompt must not resolve a local HRC session')
          },
          dispatchTurn: async () => {
            throw new Error('remote virgin input must not dispatch a local HRC turn')
          },
        }) as unknown as any,
    })

    await expect(
      launcher({
        sessionRef,
        acpRunId: acpRun.runId,
        inputAttemptId: 'ia_t4_remote_virgin',
        runStore,
        waitForCompletion: false,
        onEvent: async () => {},
        intent: {
          placement: {
            agentRoot: '/tmp/scribe',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: { provider: 'openai', interactive: false },
          initialPrompt: 'T4 ping',
        },
      })
    ).rejects.toThrow('owned by the collaboration ledger; ACP local launch refused')

    expect(calls).toEqual(['locateScope'])
    expect(runStore.getRun(acpRun.runId)).toMatchObject({ status: 'pending' })
  })

  test('keeps locally-bound interface runs on the existing session launcher', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-local-interface-'))
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
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
    const calls: string[] = []
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:hrc-runtime:task:local-discord',
      laneRef: 'main' as const,
    }
    const acpRun = runStore.createRun({
      sessionRef,
      status: 'pending',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_local',
            conversationRef: 'channel:local',
            messageRef: 'discord:message:local',
          },
        },
      },
    })
    const launcher = createRealLauncher({
      hrcDbPath,
      createClient: () =>
        ({
          locateScope: async () => {
            calls.push('locateScope')
            return {
              scopeRef: sessionRef.scopeRef,
              localNodeId: 'svc',
              federationConfigured: true,
              authority: {
                state: 'bound',
                source: 'ledger',
                isLocal: true,
                record: { homeNodeId: 'svc', placementEpoch: 2 },
              },
            }
          },
          resolveSession: async () => {
            calls.push('resolveSession')
            return { found: true, hostSessionId: 'hsid-local', generation: 2 }
          },
          dispatchTurn: async () => {
            calls.push('dispatchTurn')
            return {
              runId: 'hrc-run-local',
              hostSessionId: 'hsid-local',
              generation: 2,
              runtimeId: 'rt-local',
              transport: 'headless',
              status: 'accepted',
            }
          },
        }) as unknown as any,
    })

    try {
      const result = await launcher({
        sessionRef,
        acpRunId: acpRun.runId,
        runStore,
        waitForCompletion: false,
        onEvent: async () => {},
        intent: {
          placement: {
            agentRoot: '/tmp/cody',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: { provider: 'openai', interactive: false },
          initialPrompt: 'local prompt',
        },
      })

      expect(result).toMatchObject({
        runId: 'hrc-run-local',
        sessionId: 'hsid-local',
        hostSessionId: 'hsid-local',
      })
      expect(calls).toEqual(['locateScope', 'resolveSession', 'dispatchTurn'])
      expect(runStore.getRun(acpRun.runId)).toMatchObject({
        hrcRunId: 'hrc-run-local',
        transport: 'headless',
      })
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('headless prompt dispatches one fenced dispatchTurn and emits the assistant message_end', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-db-'))
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
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)

    const calls: string[] = []
    const seenEvents: unknown[] = []
    const launcher = createRealLauncher({
      hrcDbPath,
      pollIntervalMs: 1,
      createClient: () =>
        ({
          resolveSession: async () => {
            calls.push('resolveSession')
            return { found: true, hostSessionId: 'hsid-123', generation: 3 }
          },
          ensureRuntime: async () => {
            throw new Error('ensureRuntime should not be called for headless real-launcher turns')
          },
          dispatchTurn: async (input: unknown) => {
            calls.push('dispatchTurn')
            expect(input).toEqual({
              hostSessionId: 'hsid-123',
              prompt: 'remember chartreuse',
              fences: {
                expectedHostSessionId: 'hsid-123',
                expectedGeneration: 3,
              },
              runtimeIntent: {
                placement: {
                  agentRoot: '/tmp/rex',
                  runMode: 'task',
                  bundle: { kind: 'compose', compose: [] },
                  dryRun: false,
                },
                harness: {
                  provider: 'openai',
                  interactive: false,
                },
                execution: {
                  preferredMode: 'headless',
                },
                initialPrompt: '  remember chartreuse  ',
              },
              waitForCompletion: true,
            })
            db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
              'run-123',
              'completed'
            )
            db.run(
              'INSERT INTO events (run_id, event_kind, event_json) VALUES (?, ?, ?)',
              'run-123',
              'message_end',
              JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'chartreuse' }],
                },
              })
            )
            db.run(
              'INSERT INTO hrc_events (run_id, event_kind, payload_json) VALUES (?, ?, ?)',
              'run-123',
              'turn.completed',
              JSON.stringify({ finalOutput: 'chartreuse' })
            )
            return {
              runId: 'run-123',
              hostSessionId: 'hsid-123',
              generation: 3,
              runtimeId: 'rt-123',
              transport: 'headless',
              status: 'completed',
              supportsInFlightInput: false,
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
          scopeRef: 'agent:rex:project:agent-spaces',
          laneRef: 'main',
        },
        intent: {
          placement: {
            agentRoot: '/tmp/rex',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: {
            provider: 'openai',
            interactive: false,
          },
          execution: {
            preferredMode: 'headless',
          },
          initialPrompt: '  remember chartreuse  ',
        },
      })

      expect(result).toEqual({
        runId: 'run-123',
        sessionId: 'hsid-123',
        hostSessionId: 'hsid-123',
        runtimeId: 'rt-123',
        generation: 3,
      })
      expect(calls).toEqual(['resolveSession', 'dispatchTurn'])
      expect(seenEvents).toEqual([
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'chartreuse' }],
          },
        },
      ])
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('whitespace-only prompt resolves the session and skips dispatch', async () => {
    const calls: string[] = []
    const launcher = createRealLauncher({
      hrcDbPath: ':memory:',
      createClient: () =>
        ({
          resolveSession: async () => {
            calls.push('resolveSession')
            return { found: true, hostSessionId: 'hsid-empty' }
          },
          ensureRuntime: async () => {
            throw new Error('ensureRuntime should not be called for empty-prompt launches')
          },
          dispatchTurn: async () => {
            throw new Error('dispatchTurn should not run when no prompt is provided')
          },
        }) as unknown as any,
    })

    const result = await launcher({
      sessionRef: {
        scopeRef: 'agent:rex:project:agent-spaces',
        laneRef: 'main',
      },
      intent: {
        placement: {
          agentRoot: '/tmp/rex',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
        initialPrompt: '   ',
      },
    })

    expect(result).toEqual({
      runId: 'hsid-empty',
      sessionId: 'hsid-empty',
      hostSessionId: 'hsid-empty',
      generation: undefined,
    })
    expect(calls).toEqual(['resolveSession'])
  })

  test('uses live tmux runtime as the default transport for interface turns', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-tmux-db-'))
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
      hrcDbPath,
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
      CREATE TABLE hrc_events (
        hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `)
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
      hrcDbPath,
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

  test('throws the persisted run failure details when the HRC run fails', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-failed-db-'))
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

    const launcher = createRealLauncher({
      hrcDbPath,
      pollIntervalMs: 1,
      createClient: () =>
        ({
          resolveSession: async () => ({
            found: true,
            hostSessionId: 'hsid-failed',
          }),
          dispatchTurn: async () => {
            db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, ?, ?)',
              'run-failed',
              'failed',
              'runtime_unavailable',
              'child exited 1'
            )
            return { runId: 'run-failed' }
          },
        }) as unknown as any,
    })

    try {
      await expect(
        launcher({
          onEvent: async () => {},
          sessionRef: {
            scopeRef: 'agent:rex:project:agent-spaces',
            laneRef: 'main',
          },
          intent: {
            placement: {
              agentRoot: '/tmp/rex',
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
            },
            harness: {
              provider: 'openai',
              interactive: false,
            },
            execution: {
              preferredMode: 'headless',
            },
            initialPrompt: 'reply now',
          },
        })
      ).rejects.toThrow(
        'HRC run run-failed ended with status failed: runtime_unavailable: child exited 1'
      )
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('maps a terminated HRC run to failed without waiting for the completion timeout', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-terminated-db-'))
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

    const runStore = new InMemoryRunStore()
    const acpRun = runStore.createRun({
      sessionRef: {
        scopeRef: 'agent:rex:project:agent-spaces',
        laneRef: 'main',
      },
      status: 'pending',
    })
    const launcher = createRealLauncher({
      hrcDbPath,
      watchTimeoutMs: 50,
      pollIntervalMs: 1,
      createClient: () =>
        ({
          resolveSession: async () => ({
            found: true,
            hostSessionId: 'hsid-terminated',
          }),
          dispatchTurn: async () => {
            db.run(
              'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, ?, ?)',
              'run-terminated',
              'terminated',
              'runtime_teardown',
              'broker terminated the runtime'
            )
            return { runId: 'run-terminated' }
          },
        }) as unknown as any,
    })

    try {
      await expect(
        launcher({
          acpRunId: acpRun.runId,
          runStore,
          onEvent: async () => {},
          sessionRef: {
            scopeRef: 'agent:rex:project:agent-spaces',
            laneRef: 'main',
          },
          intent: {
            placement: {
              agentRoot: '/tmp/rex',
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
            },
            harness: {
              provider: 'openai',
              interactive: false,
            },
            execution: {
              preferredMode: 'headless',
            },
            initialPrompt: 'reply now',
          },
        })
      ).rejects.toThrow(
        'HRC run run-terminated ended with status terminated: runtime_teardown: broker terminated the runtime'
      )
      expect(runStore.getRun(acpRun.runId)).toMatchObject({
        hrcRunId: 'run-terminated',
        status: 'failed',
        errorCode: 'runtime_teardown',
        errorMessage: 'broker terminated the runtime',
      })
    } finally {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  test('persists the exact HRC run returned by broker literal dispatch', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-tmux-correlation-'))
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
      hrcDbPath,
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

  // Harness inference as a launch observes it: createRealLauncher fetches
  // placement from the HRC daemon on its socketPath and resolves the session
  // with the normalized runtime intent (no prompt, so no dispatch).
  test.each([
    {
      name: 'missing harness takes the daemon anthropic harness as headless',
      scopeRef: 'agent:rex:project:agent-spaces',
      placement: {
        agentRoot: '/agents/rex',
        projectRoot: '/projects/agent-spaces',
        cwd: '/projects/agent-spaces',
      },
      daemonHarness: { provider: 'anthropic', interactive: true } as Record<string, unknown>,
      harness: undefined,
      execution: undefined,
      expectedHarness: { provider: 'anthropic', interactive: false } as Record<string, unknown>,
      expectedExecution: { preferredMode: 'headless' } as Record<string, unknown> | undefined,
      expectedDaemonRequests: [
        {
          scopeRef: 'agent:rex:project:agent-spaces',
          agentRoot: '/agents/rex',
          projectRoot: '/projects/agent-spaces',
          cwd: '/projects/agent-spaces',
          runMode: 'task',
        },
      ] as unknown[] | undefined,
    },
    {
      name: 'agent-sdk daemon harness launches as SDK execution',
      scopeRef: 'agent:sparky:project:agent-spaces',
      placement: { agentRoot: '/agents/sparky' },
      daemonHarness: {
        provider: 'anthropic',
        frontend: 'agent-sdk',
        effectiveHarness: 'agent-sdk',
        transport: 'sdk',
        interactive: false,
      },
      harness: undefined,
      execution: undefined,
      expectedHarness: { provider: 'anthropic', interactive: false, id: 'agent-sdk' },
      expectedExecution: undefined,
      expectedDaemonRequests: undefined,
    },
    {
      name: 'codex daemon harness launches as a non-interactive headless broker',
      scopeRef: 'agent:mneme:project:media-ingest',
      placement: { agentRoot: '/agents/mneme' },
      daemonHarness: {
        provider: 'openai',
        frontend: 'codex-cli',
        effectiveHarness: 'codex',
        transport: 'cli',
        interactive: true,
      },
      harness: undefined,
      execution: undefined,
      expectedHarness: { provider: 'openai', interactive: false, id: 'codex-cli' },
      expectedExecution: { preferredMode: 'headless' },
      expectedDaemonRequests: undefined,
    },
    {
      name: 'explicit openai harness is kept and defaults to headless without a daemon read',
      scopeRef: 'agent:cody:project:agent-spaces',
      placement: {
        agentRoot: '/tmp/agents/cody',
        projectRoot: '/tmp/agent-spaces',
        cwd: '/tmp/agent-spaces',
      },
      daemonHarness: undefined,
      harness: { provider: 'openai' as const, interactive: false },
      execution: undefined,
      expectedHarness: { provider: 'openai', interactive: false },
      expectedExecution: { preferredMode: 'headless' },
      expectedDaemonRequests: [],
    },
    {
      name: 'explicit interactive preferredMode without a live tmux runtime launches interactive',
      scopeRef: 'agent:cody:project:agent-spaces',
      placement: { agentRoot: '/tmp/cody' },
      daemonHarness: undefined,
      harness: { provider: 'openai' as const, interactive: false },
      execution: { preferredMode: 'interactive' as const },
      expectedHarness: { provider: 'openai', interactive: true },
      expectedExecution: { preferredMode: 'interactive' },
      expectedDaemonRequests: [],
    },
  ])(
    'launch without a prompt resolves the session with the normalized intent: $name',
    async (row) => {
      const socketPath = join(
        tmpdir(),
        `acp-real-launcher-placement-${process.pid}-${Math.random().toString(36).slice(2)}.sock`
      )
      const daemonRequests: unknown[] = []
      const daemon = Bun.serve({
        unix: socketPath,
        fetch: async (request) => {
          if (new URL(request.url).pathname !== '/v1/placements/resolve') {
            return new Response('not found', { status: 404 })
          }
          daemonRequests.push(await request.json())
          return Response.json({
            agentRoot: row.placement.agentRoot,
            cwd: row.placement.agentRoot,
            bundle: { kind: 'agent-project', agentName: 'agent' },
            harness: row.daemonHarness,
          })
        },
      })
      const resolveRequests: Array<{ runtimeIntent: HrcRuntimeIntent; create?: boolean }> = []
      try {
        const launcher = createRealLauncher({
          hrcDbPath: ':memory:',
          socketPath,
          createClient: () =>
            ({
              resolveSession: async (request: {
                runtimeIntent: HrcRuntimeIntent
                create?: boolean
              }) => {
                resolveRequests.push(request)
                return { found: true, hostSessionId: 'hsid-normalized', generation: 1 }
              },
            }) as unknown as any,
        })

        await launcher({
          sessionRef: { scopeRef: row.scopeRef, laneRef: 'main' },
          intent: {
            placement: {
              ...row.placement,
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
            },
            ...(row.harness !== undefined ? { harness: row.harness } : {}),
            ...(row.execution !== undefined ? { execution: row.execution } : {}),
          } as HrcRuntimeIntent,
        })
      } finally {
        daemon.stop(true)
        rmSync(socketPath, { force: true })
      }

      expect(resolveRequests).toHaveLength(1)
      const runtimeIntent = resolveRequests[0]?.runtimeIntent
      expect(runtimeIntent?.harness).toEqual(row.expectedHarness)
      expect(runtimeIntent?.execution).toEqual(row.expectedExecution)
      expect(runtimeIntent?.placement.dryRun).toBe(false)
      expect(resolveRequests[0]?.create).toBe(true)
      if (row.expectedDaemonRequests !== undefined) {
        expect(daemonRequests).toEqual(row.expectedDaemonRequests)
      } else {
        expect(daemonRequests).toHaveLength(1)
      }
    }
  )
})

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
  `)
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
