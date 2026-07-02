import { describe, expect, test } from 'bun:test'
import type { ExecFlowStep, FlowNext, JobFlowStep } from 'acp-core'

import { mapJobRunStatusForFlowResponse } from '../flow-status.js'
import { validateJobFlow, validateJobFlowJob } from '../flow-validation.js'

function expectCodes(result: ReturnType<typeof validateJobFlow>, codes: readonly string[]): void {
  expect(result.valid).toBe(false)
  if (!result.valid) {
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(codes))
  }
}

function execStep(id: string, argv: string[], extra: Partial<ExecFlowStep> = {}): ExecFlowStep {
  return {
    id,
    kind: 'exec',
    exec: { argv },
    ...extra,
  }
}

function expectError(
  result: ReturnType<typeof validateJobFlow>,
  expected: { code: string; path: string }
): void {
  expect(result.valid).toBe(false)
  if (!result.valid) {
    expect(result.errors).toContainEqual(expect.objectContaining(expected))
  }
}

describe('JobFlow validation', () => {
  test('accepts a minimal concrete-input flow', () => {
    expect(
      validateJobFlow({
        sequence: [{ id: 'work', input: 'Do the work.' }],
      })
    ).toEqual({ valid: true })
  })

  test('rejects missing and empty sequence arrays', () => {
    expectCodes(validateJobFlow({}), ['missing_sequence'])
    expectCodes(validateJobFlow({ sequence: [] }), ['empty_sequence'])
  })

  test('treats omitted kind as a legacy agent step', () => {
    const legacyAgentStep: JobFlowStep = { id: 'work', input: 'Do the work.' }

    expect(validateJobFlow({ sequence: [legacyAgentStep] })).toEqual({ valid: true })
  })

  test('validates explicit step kinds as a discriminated union', () => {
    expect(
      validateJobFlow({
        sequence: [
          { id: 'agent', kind: 'agent', input: 'Do the work.', fresh: true },
          execStep('exec', ['bun', '--version'], { fresh: true }),
        ],
      })
    ).toEqual({ valid: true })

    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'bad-kind', kind: 'shell', input: 'Do the work.' }],
      }),
      ['invalid_step_kind']
    )
  })

  test('accepts a known native probe with outcome branches to idle and work targets', () => {
    // T-05417 RED: probe is a server-side named registry lookup, not an exec script.
    expect(
      validateJobFlow({
        sequence: [
          {
            id: 'gate',
            kind: 'probe',
            probe: { name: 'hrc-stale-tty-reap.v1' },
            branches: { outcome: { idle: 'succeed', work: 'reap' } },
          },
          { id: 'reap', input: 'Reap stale HRC TTY sessions.' },
        ],
      })
    ).toEqual({ valid: true })
  })

  test('rejects an unknown probe registry name with a path-specific error', () => {
    // T-05417 RED: unknown probes must fail validation/reconcile before a job can fire.
    expectError(
      validateJobFlow({
        sequence: [
          {
            id: 'gate',
            kind: 'probe',
            probe: { name: 'not-allowlisted.v1' },
            branches: { outcome: { idle: 'succeed', work: 'reap' } },
          },
          { id: 'reap', input: 'Reap stale HRC TTY sessions.' },
        ],
      }),
      { code: 'unknown_probe_name', path: 'flow.sequence[0].probe.name' }
    )
  })

  test('rejects malformed probe config and outcome branch targets', () => {
    // T-05417 RED: probe outcomes are first-class work/idle values, not exit codes.
    expectError(
      validateJobFlow({
        sequence: [
          {
            id: 'gate',
            kind: 'probe',
            probe: { name: '' },
            branches: { outcome: { idle: 'succeed', work: 'missing-step' } },
          },
        ],
      }),
      { code: 'invalid_probe_step', path: 'flow.sequence[0].probe.name' }
    )
    expectError(
      validateJobFlow({
        sequence: [
          {
            id: 'gate',
            kind: 'probe',
            probe: { name: 'hrc-stale-tty-reap.v1' },
            branches: { outcome: { idle: 'succeed', work: 'missing-step' } },
          },
        ],
      }),
      { code: 'invalid_flow_next', path: 'flow.sequence[0].branches.outcome.work' }
    )
  })

  test('rejects duplicate step ids across phases', () => {
    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'work', input: 'Do the work.' }],
        onFailure: [{ id: 'work', input: 'Report failure.' }],
      }),
      ['duplicate_step_id']
    )
  })

  test('rejects missing input, both input fields, and server-side inputFile', () => {
    expectCodes(validateJobFlow({ sequence: [{ id: 'missing' }] }), ['missing_step_input'])
    expectCodes(
      validateJobFlow({ sequence: [{ id: 'both', input: 'x', inputFile: 'prompt.md' }] }),
      ['ambiguous_step_input', 'input_file_not_allowed']
    )
    expectCodes(validateJobFlow({ sequence: [{ id: 'file', inputFile: 'prompt.md' }] }), [
      'input_file_not_allowed',
    ])
  })

  test('allows inputFile only when explicitly enabled for import paths', () => {
    expect(
      validateJobFlow(
        {
          sequence: [{ id: 'file', inputFile: 'prompt.md' }],
        },
        { allowInputFile: true }
      )
    ).toEqual({ valid: true })
  })

  test('accepts boolean fresh and rejects non-boolean fresh', () => {
    expect(
      validateJobFlow({
        sequence: [
          { id: 'fresh', input: 'Start with fresh context.', fresh: true },
          { id: 'not-fresh', input: 'Continue normally.', fresh: false },
        ],
      })
    ).toEqual({ valid: true })

    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'bad-fresh', input: 'Start with fresh context.', fresh: 'yes' }],
      }),
      ['invalid_fresh']
    )
  })

  test('accepts freshDuration only with fresh true and fixed positive durations', () => {
    expect(
      validateJobFlow({
        sequence: [
          { id: 'daily', input: 'Start with fresh context.', fresh: true, freshDuration: 'PT24H' },
          {
            id: 'compound',
            input: 'Start with fresh context.',
            fresh: true,
            freshDuration: 'P1DT2H3M4S',
          },
        ],
      })
    ).toEqual({ valid: true })

    for (const freshDuration of ['PT0S', 'P1M', 'P1Y', 'P1W', '24h', 24] as const) {
      expectCodes(
        validateJobFlow({
          sequence: [
            {
              id: `bad-${String(freshDuration)}`,
              input: 'Start with fresh context.',
              fresh: true,
              freshDuration,
            },
          ],
        }),
        ['invalid_fresh_duration']
      )
    }

    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'missing-fresh', input: 'Start.', freshDuration: 'PT24H' }],
      }),
      ['invalid_fresh_duration']
    )
    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'false-fresh', input: 'Start.', fresh: false, freshDuration: 'PT24H' }],
      }),
      ['invalid_fresh_duration']
    )
  })

  test('rejects freshDuration on non-scheduled job validation when trigger context is known', () => {
    const flow = {
      sequence: [{ id: 'fresh', input: 'Start.', fresh: true, freshDuration: 'PT24H' }],
    }

    expect(
      validateJobFlowJob({
        triggerKind: 'schedule',
        schedule: { cron: '*/20 * * * *' },
        flow,
      })
    ).toEqual({ valid: true })

    expectCodes(
      validateJobFlowJob({
        triggerKind: 'event',
        flow,
      }),
      ['invalid_fresh_duration']
    )
  })

  test('rejects unsupported expectation shapes', () => {
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'work',
            input: 'Do the work.',
            expect: { outcome: 'succeeded', unknown: true },
          },
        ],
      }),
      ['unsupported_expect_field']
    )
  })

  test('rejects invalid require entries and equals checks', () => {
    expectCodes(
      validateJobFlow({
        sequence: [
          {
            id: 'work',
            input: 'Do the work.',
            expect: {
              require: ['status', '', 'nested.value'],
              equals: {
                status: 'succeeded',
                'nested.value': true,
                details: { nested: true },
              },
            },
          },
        ],
      }),
      ['invalid_expect_require', 'invalid_expect_equals_key', 'invalid_expect_equals_value']
    )
  })

  test('rejects unsupported outcomes, invalid cron, and invalid timeout strings', () => {
    expectCodes(
      validateJobFlowJob({
        schedule: { cron: 'not a cron' },
        flow: {
          sequence: [
            {
              id: 'work',
              input: 'Do the work.',
              timeout: 'forty-five minutes',
              expect: { outcome: 'completed' },
            },
          ],
        },
      }),
      ['invalid_cron', 'invalid_timeout', 'unsupported_expect_outcome']
    )
  })

  test('validates exec step shape', () => {
    expect(
      validateJobFlow({
        sequence: [
          execStep('run', ['bun', 'run', 'test'], {
            exec: {
              argv: ['bun', 'run', 'test'],
              cwd: '/workspace',
              env: { CI: 'true' },
              timeout: 'PT5M',
              maxOutputBytes: 1024,
            },
          }),
        ],
      })
    ).toEqual({ valid: true })

    expectCodes(
      validateJobFlow({
        sequence: [
          { id: 'missing-exec', kind: 'exec' },
          { id: 'empty-argv', kind: 'exec', exec: { argv: [] } },
          { id: 'blank-arg', kind: 'exec', exec: { argv: ['bun', ''] } },
          { id: 'shell-string', kind: 'exec', exec: { command: 'bun run test' } },
          { id: 'bad-cwd', kind: 'exec', exec: { argv: ['bun'], cwd: '' } },
          { id: 'bad-env', kind: 'exec', exec: { argv: ['bun'], env: { CI: true } } },
          { id: 'bad-timeout', kind: 'exec', exec: { argv: ['bun'], timeout: '5 minutes' } },
          { id: 'bad-output-zero', kind: 'exec', exec: { argv: ['bun'], maxOutputBytes: 0 } },
          {
            id: 'bad-success-exit-codes-empty',
            kind: 'exec',
            exec: { argv: ['bun'], successExitCodes: [] },
          },
          {
            id: 'bad-success-exit-codes-value',
            kind: 'exec',
            exec: { argv: ['bun'], successExitCodes: [0, 300] },
          },
          {
            id: 'bad-output-too-large',
            kind: 'exec',
            exec: { argv: ['bun'], maxOutputBytes: Number.MAX_SAFE_INTEGER },
          },
        ],
      }),
      [
        'missing_exec',
        'invalid_exec_argv',
        'invalid_exec_command',
        'invalid_exec_cwd',
        'invalid_exec_env',
        'invalid_exec_timeout',
        'invalid_exec_max_output_bytes',
        'invalid_exec_success_exit_codes',
      ]
    )
  })

  test('validates exec branch and next targets within the same phase', () => {
    const continueToTest: FlowNext = 'test'
    const failTerminal: FlowNext = 'fail'

    expect(
      validateJobFlow({
        sequence: [
          execStep('build', ['bun', 'run', 'build'], {
            exec: { argv: ['bun', 'run', 'build'], successExitCodes: [0, 10] },
            branches: { exitCode: { '0': continueToTest, '1': failTerminal }, default: 'succeed' },
          }),
          execStep('test', ['bun', 'run', 'test'], { next: 'continue' }),
        ],
        onFailure: [{ id: 'notify', input: 'Report failure.' }],
      })
    ).toEqual({ valid: true })

    expectCodes(
      validateJobFlow({
        sequence: [
          execStep('build', ['bun', 'run', 'build'], {
            next: 'notify',
            branches: {
              exitCode: {
                '-1': 'test',
                '1.5': 'test',
                '256': 'test',
                abc: 'test',
                '2': 'missing',
                '3': 'notify',
              },
              default: 'missing',
            },
          }),
          execStep('test', ['bun', 'run', 'test']),
        ],
        onFailure: [{ id: 'notify', input: 'Report failure.' }],
      }),
      ['invalid_branch_exit_code', 'invalid_flow_next']
    )
  })

  test('rejects phase-local cycles through implicit, next, and exec branch edges', () => {
    expectCodes(
      validateJobFlow({
        sequence: [
          execStep('first', ['bun', '--version'], { next: 'second' }),
          execStep('second', ['bun', '--version'], { branches: { default: 'first' } }),
        ],
      }),
      ['flow_cycle']
    )

    expectCodes(
      validateJobFlow({
        sequence: [
          execStep('first', ['bun', '--version']),
          execStep('second', ['bun', '--version'], { branches: { exitCode: { '0': 'first' } } }),
        ],
      }),
      ['flow_cycle']
    )

    expectCodes(
      validateJobFlow({
        sequence: [{ id: 'work', input: 'Do the work.' }],
        onFailure: [
          execStep('recover', ['bun', '--version'], { next: 'report' }),
          execStep('report', ['bun', '--version'], { branches: { default: 'recover' } }),
        ],
      }),
      ['flow_cycle']
    )
  })
})

describe('mapJobRunStatusForFlowResponse', () => {
  test('maps internal scheduler statuses to flow response statuses', () => {
    expect(mapJobRunStatusForFlowResponse({ status: 'pending' })).toBe('queued')
    expect(mapJobRunStatusForFlowResponse({ status: 'claimed' })).toBe('running')
    expect(mapJobRunStatusForFlowResponse({ status: 'dispatched' })).toBe('running')
    expect(mapJobRunStatusForFlowResponse({ status: 'succeeded' })).toBe('succeeded')
    expect(mapJobRunStatusForFlowResponse({ status: 'failed' })).toBe('failed')
    expect(mapJobRunStatusForFlowResponse({ status: 'skipped' })).toBe('skipped')
  })
})
