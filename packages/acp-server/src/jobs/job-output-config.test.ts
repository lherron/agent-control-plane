import { describe, expect, test } from 'bun:test'

import { validateJobOutputConfig } from './job-output-config.js'

const SINK = { kind: 'webhook', url: 'http://127.0.0.1:18551/api' }

describe('validateJobOutputConfig delivery policy (T-10005)', () => {
  test('accepts and normalizes output.delivery', () => {
    expect(
      validateJobOutputConfig({ sinks: [SINK], delivery: { maxAttempts: 5, maxAgeSeconds: 3600 } })
    ).toEqual({
      valid: true,
      output: { sinks: [SINK], delivery: { maxAttempts: 5, maxAgeSeconds: 3600 } },
    })
  })

  test('omits delivery when absent', () => {
    expect(validateJobOutputConfig({ sinks: [SINK] })).toEqual({
      valid: true,
      output: { sinks: [SINK] },
    })
  })

  test('refuses unknown output-level keys', () => {
    const result = validateJobOutputConfig({ sinks: [SINK], retries: 3 })
    expect(result.valid).toBe(false)
    expect(result.valid === false && result.errors).toContain('output.retries is not supported')
  })

  test('refuses unknown and out-of-range delivery fields', () => {
    const cases: Array<[unknown, string]> = [
      [{ maxAttempts: 0 }, 'output.delivery.maxAttempts must be an integer from 1 to 1000'],
      [{ maxAttempts: 2.5 }, 'output.delivery.maxAttempts must be an integer from 1 to 1000'],
      [{ maxAgeSeconds: 59 }, 'output.delivery.maxAgeSeconds must be an integer from 60 to 604800'],
      [{ backoff: 'fast' }, 'output.delivery.backoff is not supported'],
      ['soon', 'output.delivery must be an object'],
    ]
    for (const [delivery, error] of cases) {
      const result = validateJobOutputConfig({ sinks: [SINK], delivery })
      expect(result.valid === false && result.errors).toContain(error)
    }
  })
})
