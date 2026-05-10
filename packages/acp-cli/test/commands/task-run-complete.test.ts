import { describe, expect, test } from 'bun:test'

import { runCli } from '../cli-test-helpers.js'

async function loadCommand(): Promise<{
  runTaskRunCompleteCommand(args: string[], deps?: { fetchImpl?: typeof fetch }): Promise<unknown>
}> {
  return import('../../src/commands/task-run-complete.js')
}

describe('acp task run-complete command', () => {
  test('posts participant run completion', async () => {
    const seen: Array<{ url: string; method?: string; body: unknown }> = []
    const { runTaskRunCompleteCommand } = await loadCommand()

    const output = await runTaskRunCompleteCommand(
      ['--server', 'http://acp.test', '--run', 'run_1', '--outcome', 'success', '--json'],
      {
        fetchImpl: async (input, init) => {
          seen.push({
            url: String(input),
            method: init?.method,
            body: JSON.parse(String(init?.body)),
          })
          return new Response(
            JSON.stringify({ participantRun: { runId: 'run_1', status: 'completed' } }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        },
      }
    )

    expect(seen).toEqual([
      {
        url: 'http://acp.test/v1/workflow-participant-runs/run_1/complete',
        method: 'POST',
        body: { outcome: 'success' },
      },
    ])
    expect(output).toEqual({
      format: 'json',
      body: { participantRun: { runId: 'run_1', status: 'completed' } },
    })
  })

  test('passes repeated evidence refs, summary, idempotency key, and --as actor header', async () => {
    const seen: Array<{ headers: Headers; body: unknown }> = []
    const { runTaskRunCompleteCommand } = await loadCommand()

    await runTaskRunCompleteCommand(
      [
        '--server',
        'http://acp.test',
        '--as',
        'agent:larry',
        '--run',
        'run_1',
        '--outcome',
        'success',
        '--evidence-ref',
        'evd_1',
        '--evidence-ref',
        'evd_2',
        '--summary',
        'done',
        '--idempotency-key',
        'cli:complete',
      ],
      {
        fetchImpl: async (_input, init) => {
          seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
          return new Response(
            JSON.stringify({ participantRun: { runId: 'run_1', status: 'completed' } }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        },
      }
    )

    expect(seen[0]?.headers.get('x-acp-actor-agent-id')).toBe('larry')
    expect(seen[0]?.body).toEqual({
      outcome: 'success',
      evidenceRefs: ['evd_1', 'evd_2'],
      summary: 'done',
      idempotencyKey: 'cli:complete',
    })
  })

  test('requires --run and --outcome', async () => {
    const { runTaskRunCompleteCommand } = await loadCommand()

    await expect(runTaskRunCompleteCommand(['--outcome', 'success'])).rejects.toThrow(
      '--run is required'
    )
    await expect(runTaskRunCompleteCommand(['--run', 'run_1'])).rejects.toThrow(
      '--outcome is required'
    )
  })

  test('is registered under acp task run-complete', async () => {
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'task',
        'run-complete',
        '--run',
        'run_1',
        '--outcome',
        'success',
        '--json',
      ],
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ participantRun: { runId: 'run_1', status: 'completed' } }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          ),
      }
    )

    expect(result.exitCode).toBe(0)
  })
})
