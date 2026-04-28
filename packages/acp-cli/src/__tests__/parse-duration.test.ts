import { describe, expect, test } from 'bun:test'

import { CliUsageError } from '../cli-runtime.js'
import { parseDurationMs } from '../commands/options.js'

describe('parseDurationMs', () => {
  test('bare integer is treated as milliseconds', () => {
    expect(parseDurationMs('--timeout', '500')).toBe(500)
    expect(parseDurationMs('--timeout', '1')).toBe(1)
  })

  test('ms suffix', () => {
    expect(parseDurationMs('--timeout', '500ms')).toBe(500)
  })

  test('s suffix multiplies by 1000', () => {
    expect(parseDurationMs('--timeout', '5s')).toBe(5_000)
    expect(parseDurationMs('--timeout', '60s')).toBe(60_000)
  })

  test('m suffix multiplies by 60_000', () => {
    expect(parseDurationMs('--timeout', '2m')).toBe(120_000)
  })

  test('rejects non-numeric input', () => {
    expect(() => parseDurationMs('--timeout', 'fast')).toThrow(CliUsageError)
  })

  test('rejects unsupported suffix', () => {
    expect(() => parseDurationMs('--timeout', '5h')).toThrow(CliUsageError)
  })

  test('rejects below min', () => {
    expect(() => parseDurationMs('--timeout', '0')).toThrow(CliUsageError)
    expect(() => parseDurationMs('--timeout', '0s', { min: 1 })).toThrow(CliUsageError)
  })

  test('rejects negative or floating-point input', () => {
    expect(() => parseDurationMs('--timeout', '-1s')).toThrow(CliUsageError)
    expect(() => parseDurationMs('--timeout', '1.5s')).toThrow(CliUsageError)
  })
})
