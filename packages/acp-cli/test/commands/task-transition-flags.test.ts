import { describe, expect, test } from 'bun:test'

import { runTaskTransitionCommand } from '../../src/commands/task-transition.js'

function transitionResponse() {
  return {
    task: { taskId: 'T-1', state: { status: 'closed', outcome: 'success' }, version: 3 },
    event: { payload: { transitionId: 'close_success' } },
    effects: [],
  }
}

describe('acp task transition flag alignment', () => {
  test('omitted --expected-version fetches the task version before transitioning', async () => {
    const seen: Array<{ url: string; method?: string; body: unknown }> = []
    await runTaskTransitionCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'larry',
        '--task',
        'T-1',
        '--transition',
        'close_success',
        '--role',
        'owner',
        '--idempotency-key',
        'cli:transition:auto-version',
      ],
      {
        fetchImpl: async (input, init) => {
          seen.push({
            url: String(input),
            method: init?.method,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
          })
          if (init?.method === 'GET') {
            return new Response(JSON.stringify({ task: { taskId: 'T-1', version: 7 } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response(JSON.stringify(transitionResponse()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen.map((call) => call.method)).toEqual(['GET', 'POST'])
    expect(seen[1]?.body).toMatchObject({ expectedTaskVersion: 7 })
  })

  test('--as agent:larry normalizes actor and --waiver-ref is optional', async () => {
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
        '7',
        '--idempotency-key',
        'cli:transition:no-waiver',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push({
            header: new Headers(init?.headers).get('x-acp-actor-agent-id'),
            body: JSON.parse(String(init?.body)),
          })
          return new Response(JSON.stringify(transitionResponse()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    )

    expect(seen[0]?.header).toBe('larry')
    expect(seen[0]?.body).toEqual(
      expect.objectContaining({
        expectedTaskVersion: 7,
        actor: { agentId: 'larry' },
      })
    )
    expect(seen[0]?.body).not.toHaveProperty('waiverRefs')
  })
})
