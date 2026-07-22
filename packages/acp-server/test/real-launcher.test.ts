import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError, HrcErrorCode, type HrcRuntimeIntent } from 'hrc-core'

import { InMemoryRunStore } from '../src/domain/run-store.js'
import {
  createRealLauncher,
  normalizeRealLauncherIntent,
  toUnifiedAssistantMessageEndFromRawEvents,
} from '../src/real-launcher.js'

describe('real launcher helpers', () => {
  test('routes remote-bound interface runs through semantic messaging without resolving locally', async () => {
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
          semanticDm: async (input: unknown) => {
            calls.push('semanticDm')
            expect(input).toMatchObject({
              from: { kind: 'entity', entity: 'human' },
              to: {
                kind: 'session',
                sessionRef: `${sessionRef.scopeRef}/lane:main`,
              },
              body: 'remember orchid',
              respondTo: { kind: 'entity', entity: 'human' },
              createIfMissing: true,
            })
            return {
              request: {
                messageSeq: 42,
                messageId: 'msg-remote-request',
                createdAt: '2026-07-21T01:30:00.000Z',
                kind: 'dm',
                phase: 'request',
                from: { kind: 'entity', entity: 'human' },
                to: {
                  kind: 'session',
                  sessionRef: `${sessionRef.scopeRef}/lane:main`,
                },
                rootMessageId: 'msg-remote-request',
                body: 'remember orchid',
                bodyFormat: 'text/plain',
                execution: { state: 'accepted' },
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

    const result = await launcher({
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

    expect(result).toEqual({
      runId: 'msg-remote-request',
      sessionId: `${sessionRef.scopeRef}/lane:main`,
    })
    expect(calls).toEqual(['locateScope', 'semanticDm'])
    expect(runStore.getRun(acpRun.runId)).toMatchObject({
      status: 'running',
      transport: 'federated-message',
      metadata: {
        meta: {
          hrcSemanticMessage: {
            requestMessageId: 'msg-remote-request',
            rootMessageId: 'msg-remote-request',
            afterSeq: 42,
            localNodeId: 'svc',
            homeNodeId: 'lab',
          },
        },
      },
    })
  })

  test('routes plain inputs for a remote-designated virgin scope through semantic messaging', async () => {
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
                declaredPolicy: { kind: 'default_home_node', homeNodeId: 'max3' },
              },
            }
          },
          semanticDm: async (input: unknown) => {
            calls.push('semanticDm')
            expect(input).toMatchObject({
              to: { kind: 'session', sessionRef: `${sessionRef.scopeRef}/lane:main` },
              body: 'T4 ping',
              createIfMissing: true,
              runtimeIntent: {
                placement: { agentRoot: '/tmp/scribe', runMode: 'task' },
              },
            })
            return {
              request: {
                messageSeq: 43,
                messageId: 'msg-t4-remote-establish',
                createdAt: '2026-07-22T22:04:16.000Z',
                kind: 'dm',
                phase: 'request',
                from: { kind: 'entity', entity: 'human' },
                to: { kind: 'session', sessionRef: `${sessionRef.scopeRef}/lane:main` },
                rootMessageId: 'msg-t4-remote-establish',
                body: 'T4 ping',
                bodyFormat: 'text/plain',
                execution: { state: 'accepted' },
              },
            }
          },
          resolveSession: async () => {
            calls.push('resolveSession')
            throw new HrcDomainError(
              HrcErrorCode.STALE_CONTEXT,
              'routes to max3 by default_home_node; this node is svc',
              {
                path: 'resolve-session',
                reason: 'routed-elsewhere',
                retryable: false,
                homeNodeId: 'max3',
              }
            )
          },
          dispatchTurn: async () => {
            throw new Error('remote virgin input must not dispatch a local HRC turn')
          },
        }) as unknown as any,
    })

    const result = await launcher({
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

    expect(result).toEqual({
      runId: 'msg-t4-remote-establish',
      sessionId: `${sessionRef.scopeRef}/lane:main`,
    })
    expect(calls).toEqual(['locateScope', 'semanticDm'])
    expect(runStore.getRun(acpRun.runId)).toMatchObject({
      status: 'running',
      transport: 'federated-message',
    })
  })

  test('turns a terminal federated delivery failure into the canonical typed cause', async () => {
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:hrc-runtime:task:remote-dead-letter',
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
          locateScope: async () => ({
            scopeRef: sessionRef.scopeRef,
            localNodeId: 'svc',
            federationConfigured: true,
            authority: {
              state: 'unbound',
              registry: { state: 'unbound' },
              declaredPolicy: { kind: 'default_home_node', homeNodeId: 'max3' },
            },
          }),
          semanticDm: async () => ({
            request: {
              messageSeq: 42,
              messageId: 'msg-remote-dead-letter',
              createdAt: '2026-07-22T20:00:00.000Z',
              kind: 'dm',
              phase: 'request',
              from: { kind: 'entity', entity: 'human' },
              to: { kind: 'session', sessionRef: `${sessionRef.scopeRef}/lane:main` },
              rootMessageId: 'msg-remote-dead-letter',
              body: 'ping',
              bodyFormat: 'text/plain',
              execution: { state: 'accepted' },
            },
          }),
          waitMessage: async () => ({
            matched: false,
            reason: 'delivery_failed',
            messageId: 'msg-remote-dead-letter',
            errorCode: 'runtime_unavailable',
            errorMessage: 'authoritative home is unreachable',
            errorReason: 'peer_unreachable',
            retryable: true,
            homeNodeId: 'max3',
          }),
        }) as unknown as any,
    })

    let failure: unknown
    try {
      await launcher({
        sessionRef,
        acpRunId: acpRun.runId,
        inputAttemptId: 'ia_remote_dead_letter',
        runStore,
        onEvent: async () => {},
        intent: {
          placement: {
            agentRoot: '/tmp/cody',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
          harness: { provider: 'openai', interactive: false },
          initialPrompt: 'ping',
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(HrcDomainError)
    expect(failure).toMatchObject({
      code: 'runtime_unavailable',
      status: 503,
      message: 'authoritative home is unreachable',
      detail: { reason: 'peer_unreachable', retryable: true, homeNodeId: 'max3' },
    })
    expect(runStore.getRun(acpRun.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'runtime_unavailable',
      errorMessage: 'authoritative home is unreachable',
    })
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
          semanticDm: async () => {
            throw new Error('local interface run must not use semantic federation')
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

  test('dispatches prompt turns through dispatchTurn and emits canonical hrc_events replies', async () => {
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

  test('returns session identity without dispatch when no prompt is provided', async () => {
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
            return { found: true, hostSessionId: 'hsid-discord', generation: 1 }
          },
          dispatchTurn: async () => {
            throw new Error('dispatchTurn should not be called when live tmux exists')
          },
          deliverLiteralBySelector: async (input: unknown) => {
            calls.push('deliverLiteralBySelector')
            if (calls.filter((call) => call === 'deliverLiteralBySelector').length === 1) {
              expect(input).toEqual({
                selector: { sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main' },
                text: 'What is 2+2?',
                enter: false,
                fences: {
                  expectedHostSessionId: 'hsid-discord',
                  expectedGeneration: 1,
                },
              })
            } else {
              expect(input).toEqual({
                selector: { sessionRef: 'agent:cody:project:agent-spaces:task:discord/lane:main' },
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
          resolveSession: async () => ({ found: true, hostSessionId: 'hsid-failed' }),
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
          resolveSession: async () => ({ found: true, hostSessionId: 'hsid-terminated' }),
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

  test('returns session identity without dispatch when no prompt is provided', async () => {
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

  test('normalizes missing harness to anthropic headless real execution', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-real-launcher-'))

    try {
      mkdirSync(join(projectRoot, 'asp_modules', 'rex', 'claude'), { recursive: true })

      const intent = {
        placement: {
          agentRoot: join(projectRoot, 'missing-agent-root'),
          projectRoot,
          cwd: projectRoot,
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          correlation: {
            sessionRef: {
              scopeRef: 'agent:rex:project:agent-spaces',
              laneRef: 'main',
            },
          },
        },
      } as HrcRuntimeIntent

      const normalized = normalizeRealLauncherIntent({
        sessionRef: {
          scopeRef: 'agent:rex:project:agent-spaces',
          laneRef: 'main',
        },
        intent,
      })

      expect(normalized.harness).toEqual({
        provider: 'anthropic',
        interactive: false,
      })
      expect(normalized.execution).toEqual({ preferredMode: 'headless' })
      expect(normalized.placement.dryRun).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('normalizes agent-sdk profile harness to SDK execution', () => {
    const agentRoot = mkdtempSync(join(tmpdir(), 'acp-real-launcher-sdk-agent-'))

    try {
      writeFileSync(
        join(agentRoot, 'agent-profile.toml'),
        [
          'schemaVersion = 2',
          '',
          '[identity]',
          'display = "Sparky"',
          'role = "smoke"',
          'harness = "agent-sdk"',
          '',
        ].join('\n')
      )

      const normalized = normalizeRealLauncherIntent({
        sessionRef: {
          scopeRef: 'agent:sparky:project:agent-spaces',
          laneRef: 'main',
        },
        intent: {
          placement: {
            agentRoot,
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
        } as HrcRuntimeIntent,
      })

      expect(normalized.harness).toEqual({
        provider: 'anthropic',
        interactive: false,
        id: 'agent-sdk',
      })
      expect(normalized.execution).toBeUndefined()
      expect(normalized.placement.dryRun).toBe(false)
    } finally {
      rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  test('normalizes codex profile harness to non-interactive headless broker intent', () => {
    const agentRoot = mkdtempSync(join(tmpdir(), 'acp-real-launcher-codex-agent-'))

    try {
      writeFileSync(
        join(agentRoot, 'agent-profile.toml'),
        [
          'schemaVersion = 2',
          '',
          '[identity]',
          'display = "Mneme"',
          'role = "media-memory"',
          'harness = "codex"',
          '',
        ].join('\n')
      )

      const normalized = normalizeRealLauncherIntent({
        sessionRef: {
          scopeRef: 'agent:mneme:project:media-ingest',
          laneRef: 'main',
        },
        intent: {
          placement: {
            agentRoot,
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
          },
        } as HrcRuntimeIntent,
      })

      expect(normalized.harness).toEqual({
        provider: 'openai',
        interactive: false,
        id: 'codex-cli',
      })
      expect(normalized.execution).toEqual({ preferredMode: 'headless' })
      expect(normalized.placement.dryRun).toBe(false)
    } finally {
      rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  test('preserves an explicit harness and defaults openai execution to headless', () => {
    const normalized = normalizeRealLauncherIntent({
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces',
        laneRef: 'main',
      },
      intent: {
        placement: {
          agentRoot: '/Users/lherron/praesidium/var/agents/cody',
          projectRoot: '/Users/lherron/praesidium/agent-spaces',
          cwd: '/Users/lherron/praesidium/agent-spaces',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
      },
    })

    expect(normalized.harness).toEqual({
      provider: 'openai',
      interactive: false,
    })
    expect(normalized.execution).toEqual({ preferredMode: 'headless' })
    expect(normalized.placement.dryRun).toBe(false)
  })

  test('honors explicit interactive preferredMode when no live tmux runtime exists', () => {
    const normalized = normalizeRealLauncherIntent({
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces',
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
        execution: {
          preferredMode: 'interactive',
        },
      },
    })

    expect(normalized.harness).toEqual({
      provider: 'openai',
      interactive: true,
    })
    expect(normalized.execution).toEqual({ preferredMode: 'interactive' })
  })

  test('passes through explicit message_end assistant events', () => {
    const event = toUnifiedAssistantMessageEndFromRawEvents([
      {
        eventKind: 'message_end',
        eventJson: {
          type: 'message_end',
          messageId: 'msg-123',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Explicit end' }],
          },
        },
      },
    ])

    expect(event).toEqual({
      type: 'message_end',
      messageId: 'msg-123',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Explicit end' }],
      },
    })
  })

  test('maps sdk assistant message rows into one message_end event', () => {
    const event = toUnifiedAssistantMessageEndFromRawEvents([
      {
        eventKind: 'sdk.message',
        eventJson: {
          type: 'message',
          role: 'assistant',
          content: 'Hello from rex',
          payload: {
            message: {
              id: 'sdk-msg-1',
            },
          },
        },
      },
    ])

    expect(event).toEqual({
      type: 'message_end',
      messageId: 'sdk-msg-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from rex' }],
      },
    })
  })

  test('falls back to sdk complete finalOutput when no assistant message row exists', () => {
    const event = toUnifiedAssistantMessageEndFromRawEvents([
      {
        eventKind: 'sdk.complete',
        eventJson: {
          type: 'complete',
          result: {
            success: true,
            finalOutput: 'Final output only',
          },
        },
      },
    ])

    expect(event).toEqual({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Final output only' }],
      },
    })
  })

  test('accumulates assistant deltas when no final message exists yet', () => {
    const event = toUnifiedAssistantMessageEndFromRawEvents([
      {
        eventKind: 'sdk.message_delta',
        eventJson: {
          type: 'message_delta',
          role: 'assistant',
          delta: '4',
        },
      },
      {
        eventKind: 'sdk.message_delta',
        eventJson: {
          type: 'message_delta',
          role: 'assistant',
          delta: '2',
        },
      },
    ])

    expect(event).toEqual({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '42' }],
      },
    })
  })

  test('returns undefined when the raw run never emitted assistant output', () => {
    expect(
      toUnifiedAssistantMessageEndFromRawEvents([
        {
          eventKind: 'sdk.message',
          eventJson: {
            type: 'message',
            role: 'user',
            content: 'ping',
          },
        },
      ])
    ).toBeUndefined()
  })
})
