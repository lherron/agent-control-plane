import { describe, expect, test } from 'bun:test'

import {
  evaluateEventMatch,
  isAgentOriginEvent,
  parseDurationToMs,
  parseWrkqWebhookEvent,
  resolveEventAction,
  validateJobTrigger,
  type WrkqWebhookEvent,
} from '../index.js'

function event(overrides: Partial<WrkqWebhookEvent> = {}): WrkqWebhookEvent {
  return {
    schema_version: 2,
    event_id: 'evt_1',
    event_seq: 1,
    event: 'created',
    occurred_at: '2026-06-07T00:00:00Z',
    origin: { actor: 'human:lance', via: 'cli' },
    ticket_id: 'T-00042',
    project_scope_id: 'agent-control-plane',
    transition: { from: null, to: 'idea' },
    container_path: 'agent-control-plane/inbox',
    labels: ['research'],
    kind: 'task',
    title: 'Investigate widget',
    slug: 'investigate-widget',
    ...overrides,
  }
}

describe('parseWrkqWebhookEvent', () => {
  test('accepts a valid v2 payload', () => {
    const result = parseWrkqWebhookEvent(event())
    expect(result.ok).toBe(true)
  })

  test('rejects wrong schema_version', () => {
    const result = parseWrkqWebhookEvent({ ...event(), schema_version: 1 })
    expect(result.ok).toBe(false)
  })

  test('rejects missing event_id / event_seq', () => {
    expect(parseWrkqWebhookEvent({ ...event(), event_id: '' }).ok).toBe(false)
    expect(parseWrkqWebhookEvent({ ...event(), event_seq: 'x' as unknown as number }).ok).toBe(false)
  })
})

describe('evaluateEventMatch', () => {
  test('matches event + transition.to + project_scope_id', () => {
    expect(
      evaluateEventMatch(
        { event: 'created', transition: { to: 'idea' }, project_scope_id: 'agent-control-plane' },
        event()
      )
    ).toBe(true)
  })

  test('transition.from null matches a creation transition', () => {
    expect(evaluateEventMatch({ transition: { from: null, to: 'idea' } }, event())).toBe(true)
    expect(evaluateEventMatch({ transition: { from: 'open', to: 'idea' } }, event())).toBe(false)
  })

  test('event list (any-of) matches', () => {
    expect(evaluateEventMatch({ event: ['updated', 'created'] }, event())).toBe(true)
    expect(evaluateEventMatch({ event: ['updated', 'moved'] }, event())).toBe(false)
  })

  test('transition predicate requires the event to carry a transition', () => {
    expect(evaluateEventMatch({ transition: { to: 'idea' } }, event({ transition: null }))).toBe(
      false
    )
  })

  test('container_path glob and labels subset', () => {
    expect(evaluateEventMatch({ container_path: 'agent-control-plane/**' }, event())).toBe(true)
    expect(evaluateEventMatch({ container_path: 'other/**' }, event())).toBe(false)
    expect(evaluateEventMatch({ labels: ['research'] }, event())).toBe(true)
    expect(evaluateEventMatch({ labels: ['research', 'missing'] }, event())).toBe(false)
  })

  test('empty match is a wildcard', () => {
    expect(evaluateEventMatch({}, event())).toBe(true)
  })

  test('origin.actor exact match', () => {
    expect(evaluateEventMatch({ origin: { actor: 'human:lance' } }, event())).toBe(true)
    expect(
      evaluateEventMatch({ origin: { actor: 'human:lance' } }, event({ origin: { actor: 'agent:cody' } }))
    ).toBe(false)
  })

  test('origin.kind match (human vs agent vs bare system)', () => {
    expect(evaluateEventMatch({ origin: { kind: 'human' } }, event())).toBe(true)
    expect(
      evaluateEventMatch({ origin: { kind: 'human' } }, event({ origin: { actor: 'agent:cody' } }))
    ).toBe(false)
    expect(
      evaluateEventMatch({ origin: { kind: 'system' } }, event({ origin: { actor: 'system' } }))
    ).toBe(true)
    expect(
      evaluateEventMatch(
        { origin: { kind: 'system' } },
        event({ origin: { actor: 'system:wrkq-system' } })
      )
    ).toBe(true)
  })

  test('"draft created by lance" composite match (the cody-review job)', () => {
    const draftByLance = event({ transition: { from: null, to: 'draft' } })
    const match = { event: 'created', transition: { to: 'draft' }, origin: { actor: 'human:lance' } }
    expect(evaluateEventMatch(match, draftByLance)).toBe(true)
    // agent draft → no match
    expect(
      evaluateEventMatch(match, event({ transition: { to: 'draft' }, origin: { actor: 'agent:rex' } }))
    ).toBe(false)
    // lance but not draft → no match
    expect(evaluateEventMatch(match, event({ transition: { to: 'open' } }))).toBe(false)
  })
})

describe('isAgentOriginEvent', () => {
  test('detects agent origin', () => {
    expect(isAgentOriginEvent(event({ origin: { actor: 'agent:clod' } }))).toBe(true)
    expect(isAgentOriginEvent(event({ origin: { actor: 'human:lance' } }))).toBe(false)
    expect(isAgentOriginEvent(event({ origin: { actor: 'system' } }))).toBe(false)
  })
})

describe('resolveEventAction (fail-closed)', () => {
  test('resolves structural scopeRef + content templates', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: 'Research {{title}} ({{ticket_id}})' },
      event: event(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolved.scopeRef).toBe(
        'agent:clod:project:agent-control-plane:task:T-00042'
      )
      expect(result.resolved.laneRef).toBe('main')
      expect(result.resolved.input['content']).toBe('Research Investigate widget (T-00042)')
      expect(result.resolved.targetTaskId).toBe('T-00042')
    }
  })

  test('undefined structural var is a template_error (never empty string)', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: 'x' },
      event: event({ ticket_id: undefined }),
    })
    expect(result.ok).toBe(false)
  })

  test('unknown template variable is rejected', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: 'Hello {{unknown_var}}' },
      event: event(),
    })
    expect(result.ok).toBe(false)
  })

  test('resolved scopeRef is validated through the SessionRef parser', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'not a scope ref {{ticket_id}}',
      inputTemplate: { content: 'x' },
      event: event(),
    })
    expect(result.ok).toBe(false)
  })

  test('untrusted title is capped but structural scopeRef never sees it', () => {
    const longTitle = 'A'.repeat(2000)
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: '{{title}}' },
      event: event({ title: longTitle }),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.resolved.input['content'] as string).length).toBeLessThanOrEqual(500)
    }
  })
})

describe('validateJobTrigger', () => {
  test('accepts a schedule trigger', () => {
    const result = validateJobTrigger({ kind: 'schedule', cron: '0 * * * *' })
    expect(result.valid).toBe(true)
  })

  test('accepts an event trigger with match', () => {
    const result = validateJobTrigger({
      kind: 'event',
      source: 'wrkq',
      match: { event: 'created', transition: { to: 'idea' } },
      originPolicy: { agent: 'allow' },
      cooldown: '5m',
    })
    expect(result.valid).toBe(true)
  })

  test('rejects event trigger without wrkq source', () => {
    expect(validateJobTrigger({ kind: 'event', source: 'github', match: {} }).valid).toBe(false)
  })

  test('rejects unknown kind and bad cooldown', () => {
    expect(validateJobTrigger({ kind: 'cron', cron: '0 * * * *' }).valid).toBe(false)
    expect(
      validateJobTrigger({ kind: 'event', source: 'wrkq', match: {}, cooldown: 'soon' }).valid
    ).toBe(false)
  })
})

describe('parseDurationToMs', () => {
  test('parses common forms', () => {
    expect(parseDurationToMs('5m')).toBe(300_000)
    expect(parseDurationToMs('1h')).toBe(3_600_000)
    expect(parseDurationToMs('30s')).toBe(30_000)
    expect(parseDurationToMs('90')).toBe(90 * 60_000)
    expect(parseDurationToMs('nope')).toBeUndefined()
  })
})
