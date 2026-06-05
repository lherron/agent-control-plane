import { describe, expect, test } from 'bun:test'

import { runTaskEvidenceAddCommand } from '../../src/commands/task-evidence-add.js'

describe('acp task evidence add flag alignment', () => {
  test('passes --summary in the evidence item', async () => {
    const seen: unknown[] = []
    await runTaskEvidenceAddCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'larry',
        '--task',
        'T-1',
        '--kind',
        'completion_note',
        '--ref',
        'artifact://done',
        '--summary',
        'test summary',
        '--idempotency-key',
        'cli:evidence:summary',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify({ evidence: [] }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]).toMatchObject({
      evidence: [{ kind: 'completion_note', ref: 'artifact://done', summary: 'test summary' }],
    })
  })

  test('--supervisor-run aliases --supervisor-run-id', async () => {
    const seen: unknown[] = []
    await runTaskEvidenceAddCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        '--task',
        'T-1',
        '--kind',
        'completion_note',
        '--ref',
        'artifact://done',
        '--supervisor-run',
        'sup_1',
        '--idempotency-key',
        'cli:evidence:supervisor',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify({ evidence: [] }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]).toMatchObject({ supervisorRunId: 'sup_1' })
  })

  test('--from-run resolves role, runId, and participantRunId from the task snapshot', async () => {
    const seen: Array<{ url: string; method?: string; body: unknown }> = []
    await runTaskEvidenceAddCommand(
      [
        '--server',
        'http://acp.test',
        '--as',
        'agent:larry',
        '--task',
        'T-1',
        '--kind',
        'completion_note',
        '--ref',
        'artifact://done',
        '--from-run',
        'participant_1',
        '--idempotency-key',
        'cli:evidence:from-run',
      ],
      {
        fetchImpl: async (input, init) => {
          seen.push({
            url: String(input),
            method: init?.method,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
          })
          if (init?.method === 'GET') {
            return new Response(
              JSON.stringify({
                source: 'wrkf',
                task: { taskId: 'T-1', version: 2 },
                instance: { revision: 2 },
                next: { transitions: [] },
                timeline: [],
                evidence: [],
                obligations: [],
                effects: [],
                runs: [
                  {
                    id: 'participant_1',
                    role: 'collector',
                    actor: 'agent:larry',
                    status: 'active',
                    startedAt: '2026-06-05T00:00:00.000Z',
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          }
          return new Response(JSON.stringify({ evidence: [] }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen.map((call) => call.method)).toEqual(['GET', 'POST'])
    expect(seen[1]?.body).toMatchObject({
      role: 'collector',
      runId: 'participant_1',
      participantRunId: 'participant_1',
    })
  })
})
