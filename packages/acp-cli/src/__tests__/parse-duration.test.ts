import { describe, expect, test } from 'bun:test'
import { parseDurationMs } from '../commands/options.js'

describe('parseDurationMs', () => {
  test('integer duration units convert to milliseconds', () => {
    for (const [input, expected] of [
      ['500', 500],
      ['1', 1],
      ['500ms', 500],
      ['5s', 5_000],
      ['60s', 60_000],
      ['2m', 120_000],
    ] as const) {
      expect(parseDurationMs('--timeout', input)).toBe(expected)
    }
  })
})
