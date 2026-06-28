import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { type WrkqWebhookEvent, adaptWrkqWebhookEvent } from 'acp-core'

import { createWrkqEventEmitter } from '../wrkq-event-emitter.js'

const NOW = () => new Date('2026-06-28T10:00:00.000Z')

function adapt(body: WrkqWebhookEvent) {
  return adaptWrkqWebhookEvent(body)
}

function taskEvent(overrides: Partial<WrkqWebhookEvent> = {}): WrkqWebhookEvent {
  return {
    schema_version: 2,
    event_id: 'evt-1',
    event_seq: 1,
    event: 'updated',
    occurred_at: '2026-06-28T09:59:00.000Z',
    origin: { actor: 'agent:cody', via: 'wrkq', run_id: null },
    ticket_id: 'T-05270',
    slug: 'wrkq-wrkf-discord-cards',
    title: 'cards',
    state: 'in_progress',
    project_scope_id: 'agent-control-plane',
    transition: { from: 'open', to: 'in_progress' },
    changed: ['state'],
    kind: 'task',
    ...overrides,
  }
}

function workflowEvent(overrides: Partial<WrkqWebhookEvent> = {}): WrkqWebhookEvent {
  return {
    schema_version: 2,
    event_id: 'wfe-1',
    event_seq: 2,
    event: 'workflow_transitioned',
    occurred_at: '2026-06-28T09:58:00.000Z',
    origin: { actor: 'agent:smokey', via: 'wrkf', run_id: 'run-xyz' },
    ticket_id: 'T-05270',
    slug: 'wrkq-wrkf-discord-cards',
    transition: { from: 'triage', to: 'build' },
    workflow: {
      instance_id: 'wf-1',
      transition: 'do_build',
      outcome: 'review_complete',
      from: { status: 'triage' },
      to: { status: 'build' },
    },
    project_scope_id: 'agent-control-plane',
    ...overrides,
  }
}

describe('wrkq event emitter (T-05270)', () => {
  // Required test #1
  test('valid wrkq task event appends exactly one wrkq.* system event', () => {
    const admin = createInMemoryAdminStore()
    const emitter = createWrkqEventEmitter({ systemEvents: admin.systemEvents, now: NOW })

    emitter.emit(adapt(taskEvent()))

    const rows = admin.systemEvents.list({ kind: 'wrkq.updated' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({
      canonicalEventId: 'wrkq:evt-1',
      sourceEventId: 'evt-1',
      event: 'updated',
      ticket_id: 'T-05270',
      slug: 'wrkq-wrkf-discord-cards',
      state: 'in_progress',
      transition: { from: 'open', to: 'in_progress' },
      changed: ['state'],
      origin: { actor: 'agent:cody', via: 'wrkq' },
      projectId: 'agent-control-plane',
    })
    expect(rows[0]?.occurredAt).toBe('2026-06-28T09:59:00.000Z')
  })

  // Required test #2
  test('valid wrkf workflow event appends exactly one wrkf.* system event with workflow payload', () => {
    const admin = createInMemoryAdminStore()
    const emitter = createWrkqEventEmitter({ systemEvents: admin.systemEvents, now: NOW })

    emitter.emit(adapt(workflowEvent()))

    const rows = admin.systemEvents.list({ kind: 'wrkf.workflow_transitioned' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({
      // canonical id is source-qualified by TRANSPORT (wrkq), even though the
      // system-event kind family is the DOMAIN (wrkf).
      canonicalEventId: 'wrkq:wfe-1',
      ticket_id: 'T-05270',
      workflow: { instance_id: 'wf-1', outcome: 'review_complete' },
    })
  })

  // Required test #3
  test('duplicate delivery of the same canonical id does not append a second row', () => {
    const admin = createInMemoryAdminStore()
    const emitter = createWrkqEventEmitter({ systemEvents: admin.systemEvents, now: NOW })

    emitter.emit(adapt(taskEvent()))
    emitter.emit(adapt(taskEvent())) // replay, same event_id

    expect(admin.systemEvents.list({ kind: 'wrkq.updated' })).toHaveLength(1)
  })

  // Required test #5 (emitter half): unknown event name appends nothing.
  test('unknown event name appends no lifecycle system event', () => {
    const admin = createInMemoryAdminStore()
    const emitter = createWrkqEventEmitter({ systemEvents: admin.systemEvents, now: NOW })

    emitter.emit(adapt(taskEvent({ event: 'snoozed', event_id: 'evt-unknown' })))

    expect(admin.systemEvents.list()).toHaveLength(0)
  })

  test('emit is observer-only: a failing append never throws, onError is notified', () => {
    let captured: unknown
    const emitter = createWrkqEventEmitter({
      systemEvents: {
        existsWithPayloadField: () => false,
        append: () => {
          throw new Error('store down')
        },
      } as never,
      now: NOW,
      onError: (err) => {
        captured = err
      },
    })

    expect(() => emitter.emit(adapt(taskEvent()))).not.toThrow()
    expect((captured as Error).message).toBe('store down')
  })
})
