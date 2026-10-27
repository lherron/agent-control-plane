import { describe, expect, test } from 'bun:test'

import type { StepExpectation } from 'acp-core'

import {
  type ParsedResultBlock,
  evaluateExpectation,
  mapRunStatusToOutcome,
} from '../../src/jobs/result-block.js'

describe('evaluateExpectation', () => {
  test('run outcome is checked against expect.outcome (default succeeded); a mismatch names both outcomes', () => {
    const cases: Array<{
      runStatus: 'completed' | 'failed' | 'cancelled'
      expectation: StepExpectation
      mismatch?: { expected: string; actual: string } | undefined
    }> = [
      { runStatus: 'completed', expectation: {} },
      { runStatus: 'completed', expectation: { outcome: 'succeeded' } },
      { runStatus: 'failed', expectation: { outcome: 'failed' } },
      { runStatus: 'cancelled', expectation: { outcome: 'cancelled' } },
      {
        runStatus: 'failed',
        expectation: {},
        mismatch: { expected: 'succeeded', actual: 'failed' },
      },
      {
        runStatus: 'cancelled',
        expectation: {},
        mismatch: { expected: 'succeeded', actual: 'cancelled' },
      },
      {
        runStatus: 'completed',
        expectation: { outcome: 'failed' },
        mismatch: { expected: 'failed', actual: 'succeeded' },
      },
      {
        runStatus: 'completed',
        expectation: { outcome: 'cancelled' },
        mismatch: { expected: 'cancelled', actual: 'succeeded' },
      },
    ]

    for (const { runStatus, expectation, mismatch } of cases) {
      const result = evaluateExpectation(mapRunStatusToOutcome(runStatus), undefined, expectation)
      if (mismatch === undefined) {
        expect(result).toEqual({ ok: true })
      } else {
        expect(result.ok).toBe(false)
        expect(result.error).toEqual({
          code: 'run_outcome_mismatch',
          message: `expected outcome "${mismatch.expected}", got "${mismatch.actual}"`,
        })
      }
    }
  })

  test('result_block_missing: resultBlock expected but parsedResult is undefined', () => {
    const result = evaluateExpectation('succeeded', undefined, {
      resultBlock: 'RESULT',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('result_block_missing')
  })

  test('require passes when every listed field exists and otherwise names the first missing field', () => {
    const passing: Array<{ data: Record<string, unknown>; require: string[] }> = [
      { data: { a: 1, b: 2 }, require: ['a', 'b'] },
      { data: { a: 1 }, require: [] },
    ]
    for (const { data, require } of passing) {
      const parsed: ParsedResultBlock = { ok: true, data }
      expect(evaluateExpectation('succeeded', parsed, { resultBlock: 'RESULT', require })).toEqual({
        ok: true,
        result: data,
      })
    }

    const parsed: ParsedResultBlock = { ok: true, data: { a: 1 } }
    const result = evaluateExpectation('succeeded', parsed, {
      resultBlock: 'RESULT',
      require: ['a', 'b'],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('required_result_field_missing')
    expect(result.error?.message).toContain('b')
    expect(result.result).toEqual({ a: 1 })
  })

  test('equals mismatch reports result_field_mismatch naming the field, with expected and actual when present', () => {
    const cases: Array<{
      data: Record<string, unknown>
      equals: Record<string, string | number | boolean | null>
      message: string
    }> = [
      {
        data: { status: 'error' },
        equals: { status: 'ok' },
        message: 'field "status": expected "ok", got "error"',
      },
      { data: { count: 10 }, equals: { count: 20 }, message: 'field "count": expected 20, got 10' },
      {
        data: { active: false },
        equals: { active: true },
        message: 'field "active": expected true, got false',
      },
      {
        data: { other: 'value' },
        equals: { missing: 'expected' },
        message: 'field "missing" not found in result block',
      },
    ]

    for (const { data, equals, message } of cases) {
      const parsed: ParsedResultBlock = { ok: true, data }
      const result = evaluateExpectation('succeeded', parsed, { resultBlock: 'RESULT', equals })
      expect(result.ok).toBe(false)
      expect(result.error).toEqual({ code: 'result_field_mismatch', message })
      expect(result.result).toEqual(data)
    }
  })

  test('a failed run reports run_outcome_mismatch even when its result block would also mismatch', () => {
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
