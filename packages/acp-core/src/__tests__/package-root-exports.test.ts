import { describe, expect, test } from 'bun:test'

import type { DeliveryOutcome } from '../index.js'

describe('package root exports', () => {
  test('exports DeliveryOutcome from the package root', () => {
    const outcome: DeliveryOutcome = { state: 'complete' }

    expect(outcome).toEqual({ state: 'complete' })
  })
})
