import { describe, expect, test } from 'bun:test'

import { runTaskEvidenceAddCommand } from '../../src/commands/task-evidence-add.js'
import { runTaskRunCommand } from '../../src/commands/task-run.js'
import { runTaskTransitionCommand } from '../../src/commands/task-transition.js'

describe('CLI --as actor alias', () => {
  test('--as larry and --as agent:larry normalize to actor header larry for evidence add', async () => {
    const headers: Array<string | null> = []
    for (const actor of ['larry', 'agent:larry']) {
      await runTaskEvidenceAddCommand(
        [
          '--server',
          'http://acp.test',
          '--as',
          actor,
          '--task',
          'T-1',
          '--kind',
          'completion_note',
          '--ref',
          'artifact://done',
          '--idempotency-key',
          `cli:evidence:${actor}`,
        ],
        {
          fetchImpl: async (_input, init) => {
            headers.push(new Headers(init?.headers).get('x-acp-actor-agent-id'))
            return new Response(JSON.stringify({ evidence: [] }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            })
          },
        }
      )
    }

    expect(headers).toEqual(['larry', 'larry'])
  })

  test('--as agent:larry normalizes for task transition', async () => {
    const seen: Array<{ header: string | null; body: unknown }> = []
    await runTaskTransitionCommand(
      [
        '--server',
        'http://acp.test',
        '--as',
        'agent:larry',
        '--task',
        'T-1',
        '--transition',
        'close_success',
        '--role',
        'owner',
        '--expected-version',
        '2',
        '--idempotency-key',
        'cli:transition',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push({
            header: new Headers(init?.headers).get('x-acp-actor-agent-id'),
            body: JSON.parse(String(init?.body)),
          })
          return new Response(
            JSON.stringify({
              task: { taskId: 'T-1', state: { status: 'closed', outcome: 'success' } },
              event: { payload: { transitionId: 'close_success' } },
              effects: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        },
      }
    )

    expect(seen[0]).toMatchObject({
      header: 'larry',
      body: { actor: { agentId: 'larry' } },
    })
  })

  test('--as agent:larry normalizes for task run', async () => {
    const seen: Array<{ header: string | null; body: unknown }> = []
    await runTaskRunCommand(
      [
        '--server',
        'http://acp.test',
        '--as',
        'agent:larry',
        '--task',
        'T-1',
        '--role',
        'collector',
        '--harness',
        'codex',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push({
            header: new Headers(init?.headers).get('x-acp-actor-agent-id'),
            body: JSON.parse(String(init?.body)),
          })
          return new Response(
            JSON.stringify({
              participantRun: {
                runId: 'run_1',
                kind: 'participant',
                taskId: 'T-1',
                role: 'collector',
                actor: { kind: 'agent', id: 'larry' },
                status: 'launched',
                taskVersionAtStart: 0,
                contextHash: 'sha256:context',
                createdAt: '2026-05-10T12:00:00.000Z',
              },
              context: { contextHash: 'sha256:context', task: { id: 'T-1', version: 0 } },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          )
        },
      }
    )

    expect(seen[0]).toMatchObject({
      header: 'larry',
      body: { actor: { kind: 'agent', id: 'larry' } },
    })
  })
})
