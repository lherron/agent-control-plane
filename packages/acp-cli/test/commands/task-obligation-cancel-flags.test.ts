import { describe, expect, test } from 'bun:test'

import { runCli } from '../cli-test-helpers.js'

describe('acp task obligation cancel flag alignment', () => {
  test("task obligation cancel without --reason sends the request and surfaces the server's invalid_evidence", async () => {
    const requests: Array<{ method: string | undefined; body: unknown }> = []
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'rex',
        'task',
        'obligation',
        'cancel',
        '--task',
        'T-1',
        '--obligation',
        'obl_1',
        '--idempotency-key',
        'cli:cancel:no-reason',
        '--json',
      ],
      {
        fetchImpl: async (_input, init) => {
          requests.push({
            method: init?.method,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
          })
          return new Response(
            JSON.stringify({
              error: { code: 'invalid_evidence', message: 'reason is required' },
            }),
            { status: 422, headers: { 'content-type': 'application/json' } }
          )
        },
      }
    )

    // The parser does not preempt the missing reason: exactly one request reaches the server.
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.body).not.toHaveProperty('reason')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('invalid_evidence')
  })
})
