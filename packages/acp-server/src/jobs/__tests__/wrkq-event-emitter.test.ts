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

  test('comment_added projects only bounded comment details and keeps raw bodies out of system events', () => {
    // T-05316 red bar: Discord work-activity cards consume this observer payload;
    // the emitter must project a compact contract instead of leaking producer blobs.
    const admin = createInMemoryAdminStore()
    const emitter = createWrkqEventEmitter({ systemEvents: admin.systemEvents, now: NOW })
    const rawBody = `First line\u0000\n\n${'x'.repeat(300)}`

    emitter.emit(
      adapt(
        taskEvent({
          event: 'comment_added',
          event_id: 'comment-event-1',
          changed: ['comments'],
          changes: { comments: { from: null, to: 'comment-1' } },
          comment: {
            id: 'comment-1',
            author: 'human:lance',
            body: rawBody,
            preview: rawBody,
            attachments: [{ name: 'secret.txt' }],
          },
        })
      )
    )

    const payload = admin.systemEvents.list({ kind: 'wrkq.comment_added' })[0]?.payload
    expect(payload?.['comment']).toEqual({
      id: 'comment-1',
      author: 'human:lance',
      preview: expect.any(String),
    })
    const preview = (payload?.['comment'] as { preview: string } | undefined)?.preview
    expect(preview).toBeDefined()
    expect(preview?.length).toBeLessThanOrEqual(240)
    expect(preview).not.toContain('\n')
    expect(preview).not.toContain('\u0000')
    expect(payload).not.toHaveProperty('comment.body')
    expect(payload).not.toHaveProperty('comment.attachments')
    expect(payload?.['changes']).toBeUndefined()
  })

  test('updated and workflow events project renderer-safe summaries without raw nested payloads', () => {
    // T-05316 red bar: keep useful summaries, but do not forward arbitrary
    // producer objects that Discord must never render or inspect.
    const admin = createInMemoryAdminStore()
    const emitter = createWrkqEventEmitter({ systemEvents: admin.systemEvents, now: NOW })

    emitter.emit(
      adapt(
        taskEvent({
          event_id: 'updated-event-1',
          event: 'updated',
          changed: ['title', 'description', 'priority'],
          changes: {
            title: { from: 'old title', to: 'new title' },
            priority: { from: 2, to: 1 },
            description: { from: 'old private body', to: 'new private body' },
            workflow: { from: null, to: { payload: { evidence: 'private' } } },
          },
        })
      )
    )

    const updatedPayload = admin.systemEvents.list({ kind: 'wrkq.updated' })[0]?.payload
    expect(updatedPayload?.['changes']).toEqual({
      title: { from: 'old title', to: 'new title' },
      priority: { from: 2, to: 1 },
    })
    expect(JSON.stringify(updatedPayload)).not.toContain('private body')
    expect(JSON.stringify(updatedPayload)).not.toContain('evidence')

    emitter.emit(
      adapt(
        workflowEvent({
          event_id: 'workflow-event-1',
          event: 'workflow_transitioned',
          workflow: {
            instance_id: 'wf-1',
            transition: 'start_red',
            action: 'implement',
            outcome: 'accepted',
            run_id: 'run-1',
            action_run_id: 'action-run-1',
            from: { status: 'ready', phase: 'red' },
            to: { status: 'active', phase: 'green' },
            next_actions: ['review', 'ship', 'extra-1', 'extra-2', 'extra-3', 'extra-4'],
            blocked_obligations: [
              { id: 'obl-1', label: 'Needs verification', role: 'smokey', status: 'open' },
              { id: 'obl-2', label: 'x'.repeat(120), payload: { evidence: 'raw' } },
            ],
            checks: [{ id: 'check-1', label: 'unit bar', status: 'failed', output: 'raw logs' }],
            payload: { evidence: 'raw evidence body' },
          },
        })
      )
    )

    const workflowPayload = admin.systemEvents.list({ kind: 'wrkf.workflow_transitioned' })[0]
      ?.payload
    expect(workflowPayload?.['workflow']).toMatchObject({
      instance_id: 'wf-1',
      transition: 'start_red',
      action: 'implement',
      outcome: 'accepted',
      run_id: 'run-1',
      action_run_id: 'action-run-1',
      from: { status: 'ready', phase: 'red' },
      to: { status: 'active', phase: 'green' },
      next_actions: ['review', 'ship', 'extra-1', 'extra-2', 'extra-3'],
      blocked_obligations: [
        { id: 'obl-1', label: 'Needs verification', role: 'smokey', status: 'open' },
      ],
      checks: [{ id: 'check-1', label: 'unit bar', status: 'failed' }],
    })
    expect(JSON.stringify(workflowPayload)).not.toContain('raw evidence')
    expect(JSON.stringify(workflowPayload)).not.toContain('raw logs')
  })
})
