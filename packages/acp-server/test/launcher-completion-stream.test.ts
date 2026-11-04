import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RealLauncherClient, createRealLauncher } from '../src/real-launcher.js'

for (const scenario of [
  'event',
  'ready',
  'reconnect',
  'gap',
  'ledger_replaced',
  'home_unreachable',
  'timeout',
  'tail-timeout',
] as const) {
  test(`launcher completion stream: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-completion-stream-'))
    const hrcDbPath = join(dir, 'hrc.sqlite')
    const db = new Database(hrcDbPath)
    db.exec(
      'CREATE TABLE runs (run_id TEXT PRIMARY KEY, status TEXT, error_code TEXT, error_message TEXT)'
    )
    let watches = 0
    let closed = 0
    let completionEventDelivered = false
    const client = {
      resolveSession: async () => ({ found: true, hostSessionId: 'hs-test', generation: 1 }),
      dispatchTurn: async () => {
        db.run("INSERT INTO runs VALUES ('run-test', 'running', NULL, NULL)")
        return { runId: 'run-test' }
      },
      tailEvents: async () =>
        scenario === 'tail-timeout'
          ? new Promise<never>(() => {})
          : { ledgerIncarnationId: 'epoch', headHrcSeq: 10 },
      async *watchBoundedEvents(options: { runId: string; afterSeq: number; signal: AbortSignal }) {
        watches++
        expect(options.runId).toBe('run-test')
        expect(options.afterSeq).toBe(10)
        try {
          if (scenario === 'reconnect' && watches === 1) throw new Error('disconnected')
          if (['gap', 'ledger_replaced', 'home_unreachable'].includes(scenario) && watches === 1) {
            yield { type: scenario }
            return
          }
          if (scenario === 'ready' || watches === 2) db.run("UPDATE runs SET status = 'terminated'")
          yield { type: 'ready' }
          if (scenario === 'event') {
            await Bun.sleep(10)
            db.run("UPDATE runs SET status = 'terminated'")
            yield {
              type: 'event',
              event: { runId: 'run-test', eventKind: 'turn.tool_call', hrcSeq: 11 },
            }
            yield {
              type: 'event',
              event: { runId: 'other-run', eventKind: 'turn.completed', hrcSeq: 12 },
            }
            completionEventDelivered = true
            yield {
              type: 'event',
              event: { runId: 'run-test', eventKind: 'turn.completed', hrcSeq: 13 },
            }
          }
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) resolve()
            else options.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        } finally {
          closed++
        }
      },
    } as unknown as RealLauncherClient
    const launcher = createRealLauncher({
      hrcDbPath,
      socketPath: join(dir, 'unused.sock'),
      watchTimeoutMs: scenario.endsWith('timeout') ? 80 : 3000,
      createClient: () => client,
    })
    try {
      await expect(
        launcher({
          sessionRef: { scopeRef: 'agent:cody:project:agent-control-plane', laneRef: 'main' },
          intent: {
            placement: {
              agentRoot: '/tmp/cody',
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
            },
            harness: { provider: 'openai', interactive: false },
            initialPrompt: 'test',
          },
          onEvent: async () => {},
        })
      ).rejects.toThrow(
        scenario.endsWith('timeout') ? 'timed out waiting' : 'ended with status terminated'
      )
      expect(watches).toBe(
        scenario === 'tail-timeout'
          ? 0
          : ['reconnect', 'gap', 'ledger_replaced', 'home_unreachable'].includes(scenario)
            ? 2
            : 1
      )
      expect(closed).toBe(watches)
      if (scenario === 'event') expect(completionEventDelivered).toBe(true)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
