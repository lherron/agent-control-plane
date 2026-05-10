import { describe, expect, test } from 'bun:test'

import { runTaskObligationCancelCommand } from '../../src/commands/task-obligation-cancel.js'
import { runTaskObligationWaiveCommand } from '../../src/commands/task-obligation-waive.js'

describe('task obligation waive/cancel commands', () => {
  test('waives an obligation with reason and repeated evidence refs', async () => {
    const seen: Array<{ url: string; init?: RequestInit | undefined; body: unknown }> = []
    const fetchImpl = async (input: Request | string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        init,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      return new Response(
        JSON.stringify({
          obligation: {
            obligationId: 'obl_1',
            taskId: 'T-12345',
            status: 'waived',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const output = await runTaskObligationWaiveCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'coordinator',
        '--task',
        'T-12345',
        '--obligation',
        'obl_1',
        '--reason',
        'accepted risk',
        '--evidence-ref',
        'artifact://approval',
        '--evidence-ref',
        'artifact://ticket',
        '--idempotency-key',
        'cli:obligation:waive',
      ],
      { fetchImpl }
    )

    expect(output).toMatchObject({ text: expect.stringContaining('Waived obligation obl_1') })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://acp.test/v1/tasks/T-12345/obligations/obl_1/waive')
    expect(seen[0]?.init?.method).toBe('POST')
    expect(new Headers(seen[0]?.init?.headers).get('x-acp-actor-agent-id')).toBe('coordinator')
    expect(seen[0]?.body).toEqual({
      actor: { kind: 'agent', id: 'coordinator' },
      reason: 'accepted risk',
      evidenceRefs: ['artifact://approval', 'artifact://ticket'],
      idempotencyKey: 'cli:obligation:waive',
    })
  })

  test('cancels an obligation with reason', async () => {
    const seen: Array<{ url: string; init?: RequestInit | undefined; body: unknown }> = []
    const fetchImpl = async (input: Request | string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        init,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      return new Response(
        JSON.stringify({
          obligation: {
            obligationId: 'obl_1',
            taskId: 'T-12345',
            status: 'cancelled',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    const output = await runTaskObligationCancelCommand(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'coordinator',
        '--task',
        'T-12345',
        '--obligation',
        'obl_1',
        '--reason',
        'superseded',
        '--idempotency-key',
        'cli:obligation:cancel',
      ],
      { fetchImpl }
    )

    expect(output).toMatchObject({ text: expect.stringContaining('Cancelled obligation obl_1') })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://acp.test/v1/tasks/T-12345/obligations/obl_1/cancel')
    expect(seen[0]?.init?.method).toBe('POST')
    expect(new Headers(seen[0]?.init?.headers).get('x-acp-actor-agent-id')).toBe('coordinator')
    expect(seen[0]?.body).toEqual({
      actor: { kind: 'agent', id: 'coordinator' },
      reason: 'superseded',
      idempotencyKey: 'cli:obligation:cancel',
    })
  })
})
