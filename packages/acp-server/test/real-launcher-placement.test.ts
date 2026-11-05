import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HrcRuntimeIntent } from 'hrc-core'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import { createRealLauncher } from '../src/real-launcher.js'
import { createLauncherEventTable, createLauncherRunTables } from './fixtures/launcher-schema.js'

describe('real launcher placement', () => {
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
    createLauncherRunTables(db)
    createLauncherEventTable(db, 'run')
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
