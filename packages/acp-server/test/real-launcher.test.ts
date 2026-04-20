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
            return { hostSessionId: 'hsid-123' }
          },
          ensureRuntime: async () => {
            throw new Error('ensureRuntime should not be called for headless real-launcher turns')
          },
          dispatchTurn: async (input: unknown) => {
            calls.push('dispatchTurn')
            expect(input).toEqual({
              hostSessionId: 'hsid-123',
              prompt: 'remember chartreuse',
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
            return { runId: 'run-123' }
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
        interactive: false,
      })
      expect(normalized.execution).toEqual({ preferredMode: 'headless' })
      expect(normalized.placement.dryRun).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('defaults openai launches to sdk transport by leaving preferredMode unset', () => {
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
    expect(normalized.execution).toBeUndefined()
    expect(normalized.placement.dryRun).toBe(false)
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
