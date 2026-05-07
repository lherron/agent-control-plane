import { describe, expect, test } from 'bun:test'

import { createDevelopmentDashboardSnapshot } from '../../src/api/snapshot.js'

describe('ops web input admission labels', () => {
  test('development snapshot uses cody-mandated contribution labels', () => {
    const labels = createDevelopmentDashboardSnapshot().events.map((event) => event.label)

    expect(labels).toContain('Contribution pending')
    expect(labels).toContain('Contribution accepted')
    expect(labels).not.toContain('user_input_queued_in_flight')
    expect(labels).not.toContain('user_input_applied_in_flight')
    expect(labels.join('\n')).not.toMatch(/\bsteered\b/i)
    expect(labels.join('\n')).not.toMatch(/\bapplied\b/i)
  })
})
