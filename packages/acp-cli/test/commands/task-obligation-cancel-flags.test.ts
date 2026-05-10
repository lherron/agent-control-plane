import { describe, expect, test } from 'bun:test'

import { runTaskObligationCancelCommand } from '../../src/commands/task-obligation-cancel.js'
import type { AcpClientHttpError } from '../../src/http-client.js'
import { runCli } from '../cli-test-helpers.js'

describe('acp task obligation cancel flag alignment', () => {
  test('--reason is optional in the command parser and server validation is surfaced', async () => {
    await expect(
      runTaskObligationCancelCommand(
        [
          '--server',
          'http://acp.test',
          '--actor',
          'rex',
          '--task',
          'T-1',
          '--obligation',
          'obl_1',
          '--idempotency-key',
          'cli:cancel:no-reason',
        ],
        {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                error: { code: 'invalid_evidence', message: 'reason is required' },
              }),
              { status: 422, headers: { 'content-type': 'application/json' } }
            ),
        }
      )
    ).rejects.toMatchObject({
      status: 422,
      body: { error: { code: 'invalid_evidence' } },
    } satisfies Partial<AcpClientHttpError>)
  })

  test('registered CLI command does not preempt missing --reason', async () => {
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
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: { code: 'invalid_evidence', message: 'reason is required' },
            }),
            { status: 422, headers: { 'content-type': 'application/json' } }
          ),
      }
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('invalid_evidence')
  })
})
