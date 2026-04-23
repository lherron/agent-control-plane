import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openAcpStateStore } from 'acp-state-store'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcLifecycleEvent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

function createSessionRecord(overrides: Partial<HrcSessionRecord> = {}): HrcSessionRecord {
  return {
    hostSessionId: 'hsid-default',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    ancestorScopeRefs: [],
    ...overrides,
  }
}

function createRuntimeRecord(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-default',
    hostSessionId: 'hsid-default',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    ...overrides,
  }
}

function createLifecycleEvent(overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq: 41,
    streamSeq: 41,
    ts: '2026-04-23T00:00:00.000Z',
    hostSessionId: 'hsid-events-001',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
    laneRef: 'main',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.message',
    replayed: true,
    payload: {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    },
    ...overrides,
  }
}

function createHrcClientDouble(overrides: Partial<AcpHrcClient> = {}): AcpHrcClient {
  const notImplemented = (name: string) => async () => {
    throw new Error(`${name} not implemented`)
  }

  return {
    resolveSession:
      overrides.resolveSession ??
      (notImplemented('resolveSession') as unknown as AcpHrcClient['resolveSession']),
    listSessions:
      overrides.listSessions ??
      (notImplemented('listSessions') as unknown as AcpHrcClient['listSessions']),
    getSession:
      overrides.getSession ??
      (notImplemented('getSession') as unknown as AcpHrcClient['getSession']),
    clearContext:
      overrides.clearContext ??
      (notImplemented('clearContext') as unknown as AcpHrcClient['clearContext']),
    listRuntimes:
      overrides.listRuntimes ??
      (notImplemented('listRuntimes') as unknown as AcpHrcClient['listRuntimes']),
    capture: overrides.capture ?? (notImplemented('capture') as unknown as AcpHrcClient['capture']),
    getAttachDescriptor:
      overrides.getAttachDescriptor ??
      (notImplemented('getAttachDescriptor') as unknown as AcpHrcClient['getAttachDescriptor']),
    interrupt:
      overrides.interrupt ?? (notImplemented('interrupt') as unknown as AcpHrcClient['interrupt']),
    terminate:
      overrides.terminate ?? (notImplemented('terminate') as unknown as AcpHrcClient['terminate']),
    watch:
      overrides.watch ??
      // biome-ignore lint/correctness/useYield: test double that throws on use
      (async function* () {
        throw new Error('watch not implemented')
      } as unknown as AcpHrcClient['watch']),
  }
}

describe('ACP session/control endpoints', () => {
  test('GET /v1/sessions proxies HRC session listing and projects hostSessionId as sessionId', async () => {
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      listSessions: async (filter) => {
        calls.push(filter)
        return [
          createSessionRecord({
            hostSessionId: 'hsid-list-001',
            scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
          }),
        ]
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/sessions?scopeRef=agent:larry:project:agent-spaces:task:T-01165:role:tester&laneRef=main',
        })
        const payload = await fixture.json<{
          sessions: Array<{ sessionId: string; scopeRef: string; laneRef: string }>
        }>(response)

        expect(response.status).toBe(200)
        expect(payload.sessions).toEqual([
          expect.objectContaining({
            sessionId: 'hsid-list-001',
            scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
            laneRef: 'main',
          }),
        ])
        expect(calls).toEqual([
          {
            scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
            laneRef: 'main',
          },
        ])
      },
      { hrcClient }
    )
  })

  test('GET /v1/sessions/:sessionId proxies HRC session lookup', async () => {
    const calls: string[] = []
    const hrcClient = createHrcClientDouble({
      getSession: async (hostSessionId) => {
        calls.push(hostSessionId)
        return createSessionRecord({ hostSessionId })
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/sessions/hsid-show-001',
        })
        const payload = await fixture.json<{
          session: { sessionId: string; scopeRef: string; laneRef: string }
        }>(response)

        expect(response.status).toBe(200)
        expect(payload.session).toEqual(
          expect.objectContaining({
            sessionId: 'hsid-show-001',
            scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
            laneRef: 'main',
          })
        )
        expect(calls).toEqual(['hsid-show-001'])
      },
      { hrcClient }
    )
  })

  test('GET /v1/sessions/:sessionId maps HRC unknown-host-session to ACP not_found', async () => {
    const calls: string[] = []
    const hrcClient = createHrcClientDouble({
      getSession: async (hostSessionId) => {
        calls.push(hostSessionId)
        throw new HrcDomainError(
          HrcErrorCode.UNKNOWN_HOST_SESSION,
          `unknown host session: ${hostSessionId}`,
          { hostSessionId }
        )
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/sessions/hsid-missing-001',
        })
        const payload = await fixture.json<{ error: { code: string; message: string } }>(response)

        expect(response.status).toBe(404)
        expect(payload.error.code).toBe('not_found')
        expect(payload.error.message).toContain('hsid-missing-001')
        expect(calls).toEqual(['hsid-missing-001'])
      },
      { hrcClient }
    )
  })

  test('GET /v1/sessions/:sessionId/runs lists durable ACP runs by hostSessionId, not scopeRef', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'acp-session-runs-'))
    const stateStore = openAcpStateStore({ dbPath: join(stateDir, 'acp-state.db') })

    try {
      const first = stateStore.runs.createRun({
        sessionRef: {
          scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
          laneRef: 'main',
        },
        taskId: 'T-01165',
      })
      stateStore.runs.updateRun(first.runId, {
        hostSessionId: 'hsid-runs-001',
        runtimeId: 'rt-runs-001',
        status: 'running',
      })

      const second = stateStore.runs.createRun({
        sessionRef: {
          scopeRef: 'agent:curly:project:other:task:T-90001:role:implementer',
          laneRef: 'repair',
        },
        taskId: 'T-90001',
      })
      stateStore.runs.updateRun(second.runId, {
        hostSessionId: 'hsid-runs-001',
        runtimeId: 'rt-runs-002',
        status: 'pending',
      })

      const excluded = stateStore.runs.createRun({
        sessionRef: {
          scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
          laneRef: 'main',
        },
        taskId: 'T-01165',
      })
      stateStore.runs.updateRun(excluded.runId, {
        hostSessionId: 'hsid-runs-999',
        runtimeId: 'rt-runs-999',
        status: 'running',
      })

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: '/v1/sessions/hsid-runs-001/runs',
          })
          const payload = await fixture.json<{ runs: Array<{ runId: string }> }>(response)

          expect(response.status).toBe(200)
          expect(payload.runs.map((run) => run.runId).sort()).toEqual(
            [first.runId, second.runId].sort()
          )
        },
        {
          stateStore,
          runStore: stateStore.runs,
          inputAttemptStore: stateStore.inputAttempts,
        }
      )
    } finally {
      stateStore.close()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('POST /v1/sessions/reset resolves then clears the active host session', async () => {
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      resolveSession: async (request) => {
        calls.push({ method: 'resolveSession', request })
        return {
          hostSessionId: 'hsid-reset-001',
          generation: 1,
          created: false,
          session: createSessionRecord({ hostSessionId: 'hsid-reset-001' }),
        }
      },
      clearContext: async (request) => {
        calls.push({ method: 'clearContext', request })
        return {
          hostSessionId: 'hsid-reset-002',
          generation: 2,
          priorHostSessionId: 'hsid-reset-001',
        }
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/reset',
          body: {
            sessionRef: {
              scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
              laneRef: 'main',
            },
            reason: 'manual_reset',
          },
        })
        const payload = await fixture.json<{ sessionId: string; priorSessionId: string }>(response)

        expect(response.status).toBe(200)
        expect(payload).toMatchObject({
          sessionId: 'hsid-reset-002',
          priorSessionId: 'hsid-reset-001',
        })
        expect(calls).toHaveLength(2)
        expect(calls[0]).toEqual({
          method: 'resolveSession',
          request: {
            sessionRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester/lane:main',
          },
        })
        expect(calls[1]).toEqual({
          method: 'clearContext',
          request: expect.objectContaining({
            hostSessionId: 'hsid-reset-001',
          }),
        })
      },
      { hrcClient }
    )
  })

  test('POST /v1/sessions/:sessionId/interrupt interrupts the latest HRC runtime', async () => {
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      listRuntimes: async (filter) => {
        calls.push({ method: 'listRuntimes', filter })
        return [
          createRuntimeRecord({
            runtimeId: 'rt-interrupt-001',
            hostSessionId: 'hsid-interrupt-001',
          }),
        ]
      },
      interrupt: async (runtimeId) => {
        calls.push({ method: 'interrupt', runtimeId })
        return {
          ok: true,
          hostSessionId: 'hsid-interrupt-001',
          runtimeId,
        }
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/hsid-interrupt-001/interrupt',
        })
        const payload = await fixture.json<{ ok: true; runtimeId: string }>(response)

        expect(response.status).toBe(200)
        expect(payload).toMatchObject({ ok: true, runtimeId: 'rt-interrupt-001' })
        expect(calls).toEqual([
          { method: 'listRuntimes', filter: { hostSessionId: 'hsid-interrupt-001' } },
          { method: 'interrupt', runtimeId: 'rt-interrupt-001' },
        ])
      },
      { hrcClient }
    )
  })

  test('GET /v1/sessions/:sessionId/capture proxies capture from the latest HRC runtime', async () => {
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      listRuntimes: async (filter) => {
        calls.push({ method: 'listRuntimes', filter })
        return [
          createRuntimeRecord({ runtimeId: 'rt-capture-001', hostSessionId: 'hsid-capture-001' }),
        ]
      },
      capture: async (runtimeId) => {
        calls.push({ method: 'capture', runtimeId })
        return { text: 'recent pane output' }
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/sessions/hsid-capture-001/capture',
        })
        const payload = await fixture.json<{ text: string }>(response)

        expect(response.status).toBe(200)
        expect(payload).toEqual({ text: 'recent pane output' })
        expect(calls).toEqual([
          { method: 'listRuntimes', filter: { hostSessionId: 'hsid-capture-001' } },
          { method: 'capture', runtimeId: 'rt-capture-001' },
        ])
      },
      { hrcClient }
    )
  })

  test('GET /v1/sessions/:sessionId/attach-command proxies the HRC attach descriptor', async () => {
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      listRuntimes: async (filter) => {
        calls.push({ method: 'listRuntimes', filter })
        return [
          createRuntimeRecord({ runtimeId: 'rt-attach-001', hostSessionId: 'hsid-attach-001' }),
        ]
      },
      getAttachDescriptor: async (runtimeId) => {
        calls.push({ method: 'getAttachDescriptor', runtimeId })
        return {
          transport: 'tmux',
          argv: ['tmux', 'attach', '-t', 'hsid-attach-001'],
          bindingFence: {
            hostSessionId: 'hsid-attach-001',
            runtimeId,
            generation: 3,
            paneId: '%42',
          },
        }
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/sessions/hsid-attach-001/attach-command',
        })
        const payload = await fixture.json<{
          argv: string[]
          bindingFence: { hostSessionId: string; runtimeId: string; generation: number }
        }>(response)

        expect(response.status).toBe(200)
        expect(payload).toMatchObject({
          argv: ['tmux', 'attach', '-t', 'hsid-attach-001'],
          bindingFence: expect.objectContaining({
            hostSessionId: 'hsid-attach-001',
            runtimeId: 'rt-attach-001',
            generation: 3,
          }),
        })
        expect(calls).toEqual([
          { method: 'listRuntimes', filter: { hostSessionId: 'hsid-attach-001' } },
          { method: 'getAttachDescriptor', runtimeId: 'rt-attach-001' },
        ])
      },
      { hrcClient }
    )
  })

  test('POST /v1/runs/:runId/cancel marks the ACP run cancelled and interrupts the correlated HRC runtime', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'acp-run-cancel-'))
    const stateStore = openAcpStateStore({ dbPath: join(stateDir, 'acp-state.db') })
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      interrupt: async (runtimeId) => {
        calls.push({ method: 'interrupt', runtimeId })
        return {
          ok: true,
          hostSessionId: 'hsid-cancel-001',
          runtimeId,
        }
      },
    })

    try {
      const run = stateStore.runs.createRun({
        sessionRef: {
          scopeRef: 'agent:larry:project:agent-spaces:task:T-01165:role:tester',
          laneRef: 'main',
        },
        taskId: 'T-01165',
      })
      stateStore.runs.updateRun(run.runId, {
        hostSessionId: 'hsid-cancel-001',
        runtimeId: 'rt-cancel-001',
        status: 'running',
      })

      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/runs/${run.runId}/cancel`,
          })
          const payload = await fixture.json<{ run: { runId: string; status: string } }>(response)

          expect(response.status).toBe(200)
          expect(payload.run).toEqual(
            expect.objectContaining({ runId: run.runId, status: 'cancelled' })
          )
          expect(stateStore.runs.getRun(run.runId)?.status).toBe('cancelled')
          expect(calls).toEqual([{ method: 'interrupt', runtimeId: 'rt-cancel-001' }])
        },
        {
          hrcClient,
          stateStore,
          runStore: stateStore.runs,
          inputAttemptStore: stateStore.inputAttempts,
        }
      )
    } finally {
      stateStore.close()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('GET /v1/sessions/:sessionId/events replays only matching HRC events and forwards fromSeq', async () => {
    const calls: unknown[] = []
    const hrcClient = createHrcClientDouble({
      watch: (options) => {
        calls.push(options)
        return (async function* () {
          yield createLifecycleEvent({ hrcSeq: 41, hostSessionId: 'hsid-events-001' })
          yield createLifecycleEvent({ hrcSeq: 42, hostSessionId: 'hsid-other-001' })
        })()
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/sessions/hsid-events-001/events?fromSeq=41',
        })
        const text = await response.text()

        expect(response.status).toBe(200)
        expect(text).toContain('"hostSessionId":"hsid-events-001"')
        expect(text).not.toContain('"hostSessionId":"hsid-other-001"')
        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual(expect.objectContaining({ fromSeq: 41 }))
      },
      { hrcClient }
    )
  })
})
