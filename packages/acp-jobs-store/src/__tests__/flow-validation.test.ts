import { describe, expect, test } from 'bun:test'

import { mapJobRunStatusForFlowResponse } from '../flow-status.js'
import { validateJobFlow, validateJobFlowJob } from '../flow-validation.js'

function expectCodes(result: ReturnType<typeof validateJobFlow>, codes: readonly string[]): void {
  expect(result.valid).toBe(false)
  if (!result.valid) {
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(codes))
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
})

describe('mapJobRunStatusForFlowResponse', () => {
  test('maps internal scheduler statuses to flow response statuses', () => {
    expect(mapJobRunStatusForFlowResponse({ status: 'pending' })).toBe('queued')
    expect(mapJobRunStatusForFlowResponse({ status: 'claimed' })).toBe('running')
    expect(mapJobRunStatusForFlowResponse({ status: 'dispatched' })).toBe('running')
    expect(mapJobRunStatusForFlowResponse({ status: 'succeeded' })).toBe('succeeded')
    expect(mapJobRunStatusForFlowResponse({ status: 'failed' })).toBe('failed')
  })
})
