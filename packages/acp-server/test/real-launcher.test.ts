import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRealLauncher } from '../src/real-launcher.js'
import { createLauncherEventTable, createLauncherRunTables } from './fixtures/launcher-schema.js'

describe('real launcher prompt dispatch', () => {
  test('headless prompt dispatches one fenced dispatchTurn and emits the assistant message_end', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-db-'))
    const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
    const db = new Database(hrcDbPath)
    createLauncherRunTables(db)
    createLauncherEventTable(db, 'run')

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
})
