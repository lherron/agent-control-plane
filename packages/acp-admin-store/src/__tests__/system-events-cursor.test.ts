import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from '../index.js'

describe('system events afterEventId cursor + payload-field existence (T-05245)', () => {
  test('afterEventId does not skip same-occurredAt siblings', () => {
    const store = createInMemoryAdminStore()
    const occurredAt = '2026-06-28T12:00:00.000Z'
    const recordedAt = '2026-06-28T12:00:00.000Z'

    // Two events with the IDENTICAL occurred_at — an occurredAt cursor would
    // skip one of them; the event_id cursor must not.
    const first = store.systemEvents.append({
      projectId: 'p',
      kind: 'job.dispatched',
      payload: { jobRunId: 'jr-1' },
      occurredAt,
      recordedAt,
    })
    const second = store.systemEvents.append({
      projectId: 'p',
      kind: 'job.dispatched',
      payload: { jobRunId: 'jr-2' },
      occurredAt,
      recordedAt,
    })

    expect(Number(second.eventId)).toBeGreaterThan(Number(first.eventId))

    const afterFirst = store.systemEvents.list({ afterEventId: first.eventId })
    expect(afterFirst.map((e) => e.eventId)).toEqual([second.eventId])

    const afterSecond = store.systemEvents.list({ afterEventId: second.eventId })
    expect(afterSecond).toEqual([])
  })

  test('afterEventId orders by event_id and honors limit', () => {
    const store = createInMemoryAdminStore()
    for (let i = 0; i < 5; i += 1) {
      store.systemEvents.append({
        projectId: 'p',
        kind: 'job.dispatched',
        payload: { jobRunId: `jr-${i}` },
        occurredAt: '2026-06-28T12:00:00.000Z',
        recordedAt: '2026-06-28T12:00:00.000Z',
      })
    }
    const page = store.systemEvents.list({ afterEventId: '0', limit: 3 })
    expect(page).toHaveLength(3)
    const ids = page.map((e) => Number(e.eventId))
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  test('existsWithPayloadField matches kind + payload.jobRunId for idempotency', () => {
    const store = createInMemoryAdminStore()
    store.systemEvents.append({
      projectId: 'p',
      kind: 'job.completed',
      payload: { jobRunId: 'jr-9', status: 'succeeded' },
      occurredAt: '2026-06-28T12:00:00.000Z',
      recordedAt: '2026-06-28T12:00:00.000Z',
    })

    expect(
      store.systemEvents.existsWithPayloadField({
        kind: 'job.completed',
        field: 'jobRunId',
        value: 'jr-9',
      })
    ).toBe(true)
    // Wrong kind → no match (a dispatched event for the same run is independent).
    expect(
      store.systemEvents.existsWithPayloadField({
        kind: 'job.dispatched',
        field: 'jobRunId',
        value: 'jr-9',
      })
    ).toBe(false)
    expect(
      store.systemEvents.existsWithPayloadField({
        kind: 'job.completed',
        field: 'jobRunId',
        value: 'jr-absent',
      })
    ).toBe(false)
  })
})
