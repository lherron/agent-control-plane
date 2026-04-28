import { describe, expect, test } from 'bun:test'

import {
  type ParsedResultBlock,
  evaluateExpectation,
  mapRunStatusToOutcome,
} from '../../src/jobs/result-block.js'

describe('mapRunStatusToOutcome', () => {
  test('completed → succeeded', () => {
    expect(mapRunStatusToOutcome('completed')).toBe('succeeded')
  })

  test('failed → failed', () => {
    expect(mapRunStatusToOutcome('failed')).toBe('failed')
  })

  test('cancelled → cancelled', () => {
    expect(mapRunStatusToOutcome('cancelled')).toBe('cancelled')
  })
})

describe('evaluateExpectation', () => {
  // -----------------------------------------------------------------------
  // Happy paths
  // -----------------------------------------------------------------------

  test('happy path: outcome matches, no result block expected', () => {
    const result = evaluateExpectation('succeeded', undefined, {})
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('happy path: explicit outcome "succeeded" matches', () => {
    const result = evaluateExpectation('succeeded', undefined, { outcome: 'succeeded' })
    expect(result.ok).toBe(true)
  })

  test('happy path: outcome "failed" expected and matched', () => {
    const result = evaluateExpectation('failed', undefined, { outcome: 'failed' })
    expect(result.ok).toBe(true)
  })

  test('happy path: outcome "cancelled" expected and matched', () => {
    const result = evaluateExpectation('cancelled', undefined, { outcome: 'cancelled' })
    expect(result.ok).toBe(true)
  })

  test('happy path: result block with require + equals all pass', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { status: 'ok', count: 42, name: 'test' },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      require: ['status', 'count'],
      equals: { status: 'ok', count: 42 },
    })
    expect(result.ok).toBe(true)
    expect(result.result).toEqual({ status: 'ok', count: 42, name: 'test' })
  })

  test('happy path: result block with only require', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { a: 1, b: 2 },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      require: ['a', 'b'],
    })
    expect(result.ok).toBe(true)
    expect(result.result).toEqual({ a: 1, b: 2 })
  })

  test('happy path: result block with only equals', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { status: 'ok' },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: { status: 'ok' },
    })
    expect(result.ok).toBe(true)
    expect(result.result).toEqual({ status: 'ok' })
  })

  test('happy path: equals with null value', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { value: null },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: { value: null },
    })
    expect(result.ok).toBe(true)
  })

  test('happy path: equals with boolean value', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { active: true },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: { active: true },
    })
    expect(result.ok).toBe(true)
  })

  // -----------------------------------------------------------------------
  // run_outcome_mismatch
  // -----------------------------------------------------------------------

  test('run_outcome_mismatch: expected succeeded but got failed', () => {
    const result = evaluateExpectation('failed', undefined, {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('run_outcome_mismatch')
    expect(result.error?.message).toContain('succeeded')
    expect(result.error?.message).toContain('failed')
  })

  test('run_outcome_mismatch: expected failed but got succeeded', () => {
    const result = evaluateExpectation('succeeded', undefined, { outcome: 'failed' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('run_outcome_mismatch')
  })

  test('run_outcome_mismatch: expected cancelled but got succeeded', () => {
    const result = evaluateExpectation('succeeded', undefined, { outcome: 'cancelled' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('run_outcome_mismatch')
  })

  // -----------------------------------------------------------------------
  // result_block_missing
  // -----------------------------------------------------------------------

  test('result_block_missing: resultBlock expected but parsedResult is undefined', () => {
    const result = evaluateExpectation('succeeded', undefined, {
      resultBlock: 'RESULT',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_block_missing')
  })

  test('result_block_missing: parsedResult has missing error', () => {
    const parsed: ParsedResultBlock = {
      ok: false,
      error: { code: 'result_block_missing', message: 'not found' },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_block_missing')
  })

  // -----------------------------------------------------------------------
  // result_block_parse_failed
  // -----------------------------------------------------------------------

  test('result_block_parse_failed: parsedResult has parse error', () => {
    const parsed: ParsedResultBlock = {
      ok: false,
      error: { code: 'result_block_parse_failed', message: 'malformed JSON' },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_block_parse_failed')
  })

  // -----------------------------------------------------------------------
  // required_result_field_missing
  // -----------------------------------------------------------------------

  test('required_result_field_missing: required field not in data', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { a: 1 },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      require: ['a', 'b'],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('required_result_field_missing')
    expect(result.error?.message).toContain('b')
    expect(result.result).toEqual({ a: 1 })
  })

  // -----------------------------------------------------------------------
  // result_field_mismatch
  // -----------------------------------------------------------------------

  test('result_field_mismatch: equals field has wrong value', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { status: 'error' },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: { status: 'ok' },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_field_mismatch')
    expect(result.error?.message).toContain('status')
    expect(result.error?.message).toContain('ok')
    expect(result.error?.message).toContain('error')
    expect(result.result).toEqual({ status: 'error' })
  })

  test('result_field_mismatch: equals field not present in data', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { other: 'value' },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: { missing: 'expected' },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_field_mismatch')
    expect(result.error?.message).toContain('missing')
  })

  test('result_field_mismatch: numeric value mismatch', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { count: 10 },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: { count: 20 },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_field_mismatch')
  })

  test('result_field_mismatch: boolean value mismatch', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { active: false },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: { active: true },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_field_mismatch')
  })

  // -----------------------------------------------------------------------
  // Evaluation priority: outcome checked before result block
  // -----------------------------------------------------------------------

  test('outcome mismatch takes precedence over result block checks', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { status: 'wrong' },
    }
    const result = evaluateExpectation('failed', parsed, {
      resultBlock: 'RESULT',
      equals: { status: 'ok' },
    })
    // Outcome mismatch comes first
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('run_outcome_mismatch')
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test('empty expectation defaults to outcome "succeeded"', () => {
    const result = evaluateExpectation('succeeded', undefined, {})
    expect(result.ok).toBe(true)
  })

  test('require with empty array passes', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { a: 1 },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      require: [],
    })
    expect(result.ok).toBe(true)
  })

  test('equals with empty object passes', () => {
    const parsed: ParsedResultBlock = {
      ok: true,
      data: { a: 1 },
    }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      equals: {},
    })
    expect(result.ok).toBe(true)
  })
})
