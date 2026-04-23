import { describe, expect, test } from 'bun:test'

import { runRunCommand } from '../../src/commands/run.js'
import { runRuntimeCommand } from '../../src/commands/runtime.js'
import { runSendCommand } from '../../src/commands/send.js'
import { runSessionCommand } from '../../src/commands/session.js'
import { createFetchQueue } from '../cli-test-helpers.js'

describe('runtime-oriented CLI commands', () => {
  test('runtime resolve posts a normalized sessionRef', async () => {
    const queue = createFetchQueue([
      {
        body: { placement: { agentRoot: '/tmp/agents/larry', runMode: 'task' } },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/runtime/resolve')
          expect(request.body).toEqual({
            sessionRef: {
              scopeRef: 'agent:larry:project:agent-spaces:task:T-01186:role:tester',
            },
          })
        },
      },
    ])

    const output = await runRuntimeCommand(
      ['resolve', '--scope-ref', 'larry@agent-spaces:T-01186/tester'],
      {
        fetchImpl: queue.fetchImpl,
      }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { placement: { runMode: 'task' } } })
  })

  test('session show resolves a semantic scope before loading the concrete session', async () => {
    const queue = createFetchQueue([
      {
        body: { sessionId: 'hsid-123' },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/resolve')
        },
      },
      {
        body: {
          session: {
            sessionId: 'hsid-123',
            scopeRef: 'agent:larry:project:agent-spaces',
            laneRef: 'main',
            generation: 3,
            status: 'active',
            createdAt: '2026-04-23T00:00:00.000Z',
            updatedAt: '2026-04-23T00:00:00.000Z',
          },
        },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-123')
        },
      },
    ])

    const output = await runSessionCommand(
      ['show', '--scope-ref', 'agent:larry:project:agent-spaces'],
      {
        fetchImpl: queue.fetchImpl,
      }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { session: { sessionId: 'hsid-123', generation: 3 } } })
  })

  test('run cancel posts to the cancel route', async () => {
    const queue = createFetchQueue([
      {
        body: { run: { runId: 'run_123', status: 'cancelled' } },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/runs/run_123/cancel')
        },
      },
    ])

    const output = await runRunCommand(['cancel', '--run', 'run_123'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { run: { status: 'cancelled' } } })
  })

  test('send --wait polls the run until it reaches a terminal state', async () => {
    const queue = createFetchQueue([
      {
        body: {
          inputAttempt: { inputAttemptId: 'ia_123' },
          run: { runId: 'run_123', status: 'pending' },
        },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/inputs')
          expect(request.body).toMatchObject({
            sessionRef: { scopeRef: 'agent:larry:project:agent-spaces' },
            content: 'Proceed',
          })
        },
      },
      {
        body: { run: { runId: 'run_123', status: 'completed' } },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/runs/run_123')
        },
      },
    ])

    const output = await runSendCommand(
      [
        '--scope-ref',
        'agent:larry:project:agent-spaces',
        '--text',
        'Proceed',
        '--wait',
        '--wait-timeout-ms',
        '1000',
        '--wait-interval-ms',
        '1',
      ],
      { fetchImpl: queue.fetchImpl }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({
      body: { inputAttempt: { inputAttemptId: 'ia_123' }, run: { status: 'completed' } },
    })
  })
})
