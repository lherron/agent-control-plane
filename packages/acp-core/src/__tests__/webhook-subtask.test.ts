import { describe, expect, test } from 'bun:test'

import {
  type EventMatch,
  type WrkqWebhookEvent,
  adaptWrkqWebhookEvent,
  evaluateEventMatch,
  parseAcpWebhookEvent,
  parseWrkqWebhookEvent,
  resolveEventAction,
} from '../index.js'

// T-09903: fixture payloads per named-subtasks spec *Events → Webhook payload*
// (wrkq 5f22203). A subtask event's ticket_id/ticket_uuid is the subtask; the
// additive subtask_owner_id/subtask_owner_uuid name its owner. Ordinary task
// events omit both fields.
const OWNER_ID = 'T-12345'
const OWNER_UUID = '0199a000-0000-7000-8000-000000012345'
const SUBTASK_ID = 'T-12345.architecture-diagram'
const SUBTASK_UUID = '0199a000-0000-7000-8000-00000001234a'
const SIBLING_ID = 'T-12345.test-plan'
const SIBLING_UUID = '0199a000-0000-7000-8000-00000001234b'
const OTHER_OWNER_ID = 'T-54321'
const OTHER_OWNER_UUID = '0199a000-0000-7000-8000-000000054321'

function ownerEvent(overrides: Partial<WrkqWebhookEvent> = {}): WrkqWebhookEvent {
  return {
    schema_version: 2,
    event_id: 'evt_owner',
    event_seq: 10,
    event: 'comment_added',
    occurred_at: '2026-09-30T13:00:00Z',
    origin: { actor: 'human:lance', via: 'cli' },
    ticket_id: OWNER_ID,
    ticket_uuid: OWNER_UUID,
    project_scope_id: 'demo',
    container_path: 'demo/inbox',
    labels: ['design'],
    kind: 'task',
    title: 'Owner brief',
    slug: 'owner-brief',
    state: 'open',
    comment: { id: 'C-1', author: 'human:lance', preview: 'owner comment' },
    ...overrides,
  }
}

function subtaskEvent(overrides: Partial<WrkqWebhookEvent> = {}): WrkqWebhookEvent {
  return {
    ...ownerEvent(),
    event_id: 'evt_subtask',
    event_seq: 11,
    ticket_id: SUBTASK_ID,
    ticket_uuid: SUBTASK_UUID,
    subtask_owner_id: OWNER_ID,
    subtask_owner_uuid: OWNER_UUID,
    labels: ['diagram'],
    title: 'Architecture diagram',
    slug: 'architecture-diagram',
    comment: { id: 'C-2', author: 'human:lance', preview: 'subtask comment' },
    ...overrides,
  }
}

function siblingEvent(): WrkqWebhookEvent {
  return subtaskEvent({ event_id: 'evt_sibling', ticket_id: SIBLING_ID, ticket_uuid: SIBLING_UUID })
}

function otherOwnerSubtaskEvent(): WrkqWebhookEvent {
  return subtaskEvent({
    event_id: 'evt_other',
    ticket_id: `${OTHER_OWNER_ID}.architecture-diagram`,
    ticket_uuid: '0199a000-0000-7000-8000-00000005432a',
    subtask_owner_id: OTHER_OWNER_ID,
    subtask_owner_uuid: OTHER_OWNER_UUID,
  })
}

function matches(match: EventMatch, payload: WrkqWebhookEvent): boolean {
  const parsed = parseWrkqWebhookEvent(payload)
  if (!parsed.ok) {
    throw new Error(`fixture failed to parse: ${parsed.error}`)
  }
  return evaluateEventMatch(match, adaptWrkqWebhookEvent(parsed.event))
}

describe('parseWrkqWebhookEvent: subtask owner fields', () => {
  test('parses subtask_owner_id/subtask_owner_uuid as typed fields', () => {
    const parsed = parseWrkqWebhookEvent(subtaskEvent())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.event.subtask_owner_id).toBe(OWNER_ID)
      expect(parsed.event.subtask_owner_uuid).toBe(OWNER_UUID)
    }
  })

  test('ordinary task events without owner fields still parse', () => {
    const parsed = parseWrkqWebhookEvent(ownerEvent())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.event.subtask_owner_id).toBeUndefined()
    }
  })

  test('malformed owner fields are rejected fail-closed', () => {
    expect(parseWrkqWebhookEvent({ ...subtaskEvent(), subtask_owner_id: 12345 }).ok).toBe(false)
    expect(parseWrkqWebhookEvent({ ...subtaskEvent(), subtask_owner_uuid: '' }).ok).toBe(false)
    expect(parseWrkqWebhookEvent({ ...subtaskEvent(), subtask_owner_id: ' ' }).ok).toBe(false)
  })
})

describe('evaluateEventMatch: owner selectors cover subtask events', () => {
  const byOwnerId: EventMatch = { payload: { ticket_id: { eq: OWNER_ID } } }
  const byOwnerUuid: EventMatch = { payload: { ticket_uuid: { eq: OWNER_UUID } } }
  const bySubtaskId: EventMatch = { payload: { ticket_id: { eq: SUBTASK_ID } } }
  const bySubtaskUuid: EventMatch = { payload: { ticket_uuid: { anyOf: [SUBTASK_UUID] } } }

  test('owner trigger (id and uuid, eq and anyOf) fires for its own events and its subtasks', () => {
    for (const match of [
      byOwnerId,
      byOwnerUuid,
      { payload: { ticket_id: { anyOf: ['T-00001', OWNER_ID] } } },
    ]) {
      expect(matches(match, ownerEvent())).toBe(true)
      expect(matches(match, subtaskEvent())).toBe(true)
      expect(matches(match, siblingEvent())).toBe(true)
    }
  })

  test('subtask trigger fires only for its own events', () => {
    for (const match of [bySubtaskId, bySubtaskUuid]) {
      expect(matches(match, subtaskEvent())).toBe(true)
      expect(matches(match, ownerEvent())).toBe(false)
      expect(matches(match, siblingEvent())).toBe(false)
    }
  })

  test('unrelated owner trigger does not fire', () => {
    const byOtherOwner: EventMatch = { payload: { ticket_id: { eq: OTHER_OWNER_ID } } }
    expect(matches(byOtherOwner, subtaskEvent())).toBe(false)
    expect(matches(byOtherOwner, ownerEvent())).toBe(false)
    expect(matches(byOwnerId, otherOwnerSubtaskEvent())).toBe(false)
    expect(matches(byOwnerUuid, otherOwnerSubtaskEvent())).toBe(false)
  })

  test('id and uuid selectors do not cross-match', () => {
    expect(matches({ payload: { ticket_id: { eq: OWNER_UUID } } }, subtaskEvent())).toBe(false)
    expect(matches({ payload: { ticket_uuid: { eq: OWNER_ID } } }, subtaskEvent())).toBe(false)
  })

  test('label, kind and container filters apply to the event row, not the owner', () => {
    // Owner carries `design`; the subtask carries `diagram`.
    expect(matches({ ...byOwnerId, labels: ['design'] }, subtaskEvent())).toBe(false)
    expect(matches({ ...byOwnerId, labels: ['diagram'] }, subtaskEvent())).toBe(true)
    expect(matches({ ...byOwnerId, kind: 'bug' }, subtaskEvent())).toBe(false)
    expect(matches({ ...byOwnerId, container_path: 'demo/other/**' }, subtaskEvent({}))).toBe(false)
    expect(matches({ ...byOwnerId, container_path: 'demo/**' }, subtaskEvent())).toBe(true)
  })

  test('exists-only predicates and other paths keep ordinary semantics', () => {
    expect(matches({ payload: { ticket_id: { exists: true } } }, subtaskEvent())).toBe(true)
    expect(matches({ payload: { ticket_id: { exists: false } } }, subtaskEvent())).toBe(false)
    // A non-selector path never consults the owner fields.
    expect(matches({ payload: { slug: { eq: OWNER_ID } } }, subtaskEvent())).toBe(false)
  })

  test('the owner fallback is wrkq-only: a generic source is matched literally', () => {
    const parsed = parseAcpWebhookEvent({
      schema_version: 1,
      source: 'media-ingest',
      event_id: 'x-1',
      event_seq: 1,
      event: 'transcript.completed',
      payload: { ticket_id: 'T-99999.clip', subtask_owner_id: 'T-99999' },
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(evaluateEventMatch({ payload: { ticket_id: { eq: 'T-99999' } } }, parsed.event)).toBe(
        false
      )
    }
  })
})

describe('resolveEventAction: resolved target is the subtask', () => {
  test('targetKey (cooldown key) and {{ticket_id}} are the subtask id', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: 'Handle {{ticket_id}}' },
      event: adaptWrkqWebhookEvent(subtaskEvent()),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolved.targetKey).toBe(SUBTASK_ID)
      expect(result.resolved.scopeRef).toBe(`agent:clod:project:demo:task:${SUBTASK_ID}`)
      expect(result.resolved.input['content']).toBe(`Handle ${SUBTASK_ID}`)
    }
  })
})
