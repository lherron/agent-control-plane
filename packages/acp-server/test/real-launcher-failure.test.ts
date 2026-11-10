import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { createRealLauncher } from '../src/real-launcher.js'
import { createHrcRouteFake } from './fixtures/hrc-route-fake.js'
import { createLauncherRunTables } from './fixtures/launcher-schema.js'

describe('real launcher completion failure', () => {
  test('throws the persisted run failure details when the HRC run fails', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-real-launcher-failed-db-'))
    const hrcFixture = join(fixtureDir, 'hrc.sqlite')
    const db = new Database(hrcFixture)
    createLauncherRunTables(db)

    const launcher = createRealLauncher({
      hrc: createHrcRouteFake(hrcFixture),
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
    const hrcFixture = join(fixtureDir, 'hrc.sqlite')
    const db = new Database(hrcFixture)
    createLauncherRunTables(db)

    const runStore = new InMemoryRunStore()
    const acpRun = runStore.createRun({
      sessionRef: {
        scopeRef: 'agent:rex:project:agent-spaces',
        laneRef: 'main',
      },
      status: 'pending',
    })
    const launcher = createRealLauncher({
      hrc: createHrcRouteFake(hrcFixture),
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
})
