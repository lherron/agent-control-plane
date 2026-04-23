import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'

import {
  createRealLauncher,
  normalizeRealLauncherIntent,
  toUnifiedAssistantMessageEndFromRawEvents,
} from '../src/real-launcher.js'

describe('real launcher helpers', () => {
  test('dispatches prompt turns through dispatchTurn and emits codex-shaped event-table replies', async () => {
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
            return { hostSessionId: 'hsid-123', generation: 3 }
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
                  bundle: { kind: 'agent-default' },
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
            bundle: { kind: 'agent-default' },
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
            return { hostSessionId: 'hsid-empty' }
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
          bundle: { kind: 'agent-default' },
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
                  bundle: { kind: 'agent-default' },
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
            })
            return { hostSessionId: 'hsid-discord', generation: 1 }
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
            bundle: { kind: 'agent-default' },
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
          resolveSession: async () => ({ hostSessionId: 'hsid-failed' }),
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
              bundle: { kind: 'agent-default' },
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

  test('returns session identity without dispatch when no prompt is provided', async () => {
    const calls: string[] = []
    const launcher = createRealLauncher({
      hrcDbPath: ':memory:',
      createClient: () =>
        ({
          resolveSession: async () => {
            calls.push('resolveSession')
            return { hostSessionId: 'hsid-empty' }
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
          bundle: { kind: 'agent-default' },
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
          bundle: { kind: 'agent-default' },
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
        interactive: true,
      })
      expect(normalized.execution).toEqual({ preferredMode: 'headless' })
      expect(normalized.placement.dryRun).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
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
          bundle: { kind: 'agent-default' },
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
          bundle: { kind: 'agent-default' },
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
