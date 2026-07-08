import { describe, expect, test } from 'bun:test'

import {
  type AcpWebhookEvent,
  type WrkqWebhookEvent,
  adaptWrkqWebhookEvent,
  evaluateEventMatch,
  isAgentOriginEvent,
  parseAcpWebhookEvent,
  parseDurationToMs,
  parseWrkqWebhookEvent,
  resolveEventAction,
  validateJobTrigger,
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

function acpEvent(overrides: Partial<AcpWebhookEvent> = {}): AcpWebhookEvent {
  return {
    schema_version: 1,
    source: 'media-ingest',
    event_id: 'transcript-1',
    canonical_event_id: 'media-ingest:transcript-1',
    event_seq: 1,
    event: 'transcript.completed',
    occurred_at: '2026-06-13T00:00:00Z',
    origin: { actor: 'system:media-ingest', kind: 'system' },
    subject: { type: 'transcript', id: 'tr_1' },
    payload: {
      transcript_id: 'tr_1',
      backend: 'mlx',
      model_id: 'voxtral',
      nested: { status: 'ready' },
    },
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
    expect(parseWrkqWebhookEvent({ ...event(), event_seq: 'x' as unknown as number }).ok).toBe(
      false
    )
  })

  test('rejects malformed recognized enrichment objects while accepting current changes maps', () => {
    // T-05316 red bar: optional renderer enrichments are fail-closed when present,
    // while existing wrkq `changes` maps with non-renderer keys stay compatible.
    expect(
      parseWrkqWebhookEvent(
        event({
          event: 'comment_added',
          comment: {
            id: 'comment-1',
            preview: 'looks fine',
          },
        })
      ).ok
    ).toBe(true)

    expect(
      parseWrkqWebhookEvent(
        event({
          event: 'comment_added',
          comment: {
            id: 123,
            preview: ['raw', 'body'],
          },
        })
      ).ok
    ).toBe(false)

    expect(
      parseWrkqWebhookEvent(
        event({
          event: 'updated',
          changes: {
            title: { from: 'old title', to: 'new title' },
            project_uuid: { from: 'project-a', to: 'project-b' },
            workflow: { from: null, to: { instance_id: 'wf-1' } },
          },
        })
      ).ok
    ).toBe(true)
  })
})

describe('parseAcpWebhookEvent + wrkq adapter', () => {
  test('accepts a valid generic v1 envelope', () => {
    const result = parseAcpWebhookEvent(acpEvent())
    expect(result.ok).toBe(true)
  })

  test('rejects malformed generic identity/source/seq/payload', () => {
    expect(parseAcpWebhookEvent({ ...acpEvent(), source: 'Bad Source' }).ok).toBe(false)
    expect(parseAcpWebhookEvent({ ...acpEvent(), event_id: '' }).ok).toBe(false)
    expect(parseAcpWebhookEvent({ ...acpEvent(), event_seq: 1.2 }).ok).toBe(false)
    expect(parseAcpWebhookEvent({ ...acpEvent(), payload: [] }).ok).toBe(false)
  })

  test('adapts wrkq v2 into the canonical model while preserving wrkq fields', () => {
    const adapted = adaptWrkqWebhookEvent(event())
    expect(adapted.source).toBe('wrkq')
    expect(adapted.canonical_event_id).toBe('wrkq:evt_1')
    expect(adapted.subject).toEqual({ type: 'task', id: 'T-00042' })
    expect(adapted.payload['ticket_id']).toBe('T-00042')
    expect(adapted.payload['project_scope_id']).toBe('agent-control-plane')
  })
})

describe('evaluateEventMatch', () => {
  test('matches event + transition.to + project_scope_id', () => {
    expect(
      evaluateEventMatch(
        { event: 'created', transition: { to: 'idea' }, project_scope_id: 'agent-control-plane' },
        adaptWrkqWebhookEvent(event())
      )
    ).toBe(true)
  })

  test('transition.from null matches a creation transition', () => {
    expect(
      evaluateEventMatch({ transition: { from: null, to: 'idea' } }, adaptWrkqWebhookEvent(event()))
    ).toBe(true)
    expect(
      evaluateEventMatch(
        { transition: { from: 'open', to: 'idea' } },
        adaptWrkqWebhookEvent(event())
      )
    ).toBe(false)
  })

  test('event list (any-of) matches', () => {
    expect(
      evaluateEventMatch({ event: ['updated', 'created'] }, adaptWrkqWebhookEvent(event()))
    ).toBe(true)
    expect(
      evaluateEventMatch({ event: ['updated', 'moved'] }, adaptWrkqWebhookEvent(event()))
    ).toBe(false)
  })

  test('transition predicate requires the event to carry a transition', () => {
    expect(
      evaluateEventMatch(
        { transition: { to: 'idea' } },
        adaptWrkqWebhookEvent(event({ transition: null }))
      )
    ).toBe(false)
  })

  test('container_path glob and labels subset', () => {
    expect(
      evaluateEventMatch(
        { container_path: 'agent-control-plane/**' },
        adaptWrkqWebhookEvent(event())
      )
    ).toBe(true)
    expect(evaluateEventMatch({ container_path: 'other/**' }, adaptWrkqWebhookEvent(event()))).toBe(
      false
    )
    expect(evaluateEventMatch({ labels: ['research'] }, adaptWrkqWebhookEvent(event()))).toBe(true)
    expect(
      evaluateEventMatch({ labels: ['research', 'missing'] }, adaptWrkqWebhookEvent(event()))
    ).toBe(false)
  })

  test('empty match is a wildcard', () => {
    expect(evaluateEventMatch({}, adaptWrkqWebhookEvent(event()))).toBe(true)
  })

  test('origin.actor exact match', () => {
    expect(
      evaluateEventMatch({ origin: { actor: 'human:lance' } }, adaptWrkqWebhookEvent(event()))
    ).toBe(true)
    expect(
      evaluateEventMatch(
        { origin: { actor: 'human:lance' } },
        adaptWrkqWebhookEvent(event({ origin: { actor: 'agent:cody' } }))
      )
    ).toBe(false)
  })

  test('origin.kind match (human vs agent vs bare system)', () => {
    expect(evaluateEventMatch({ origin: { kind: 'human' } }, adaptWrkqWebhookEvent(event()))).toBe(
      true
    )
    expect(
      evaluateEventMatch(
        { origin: { kind: 'human' } },
        adaptWrkqWebhookEvent(event({ origin: { actor: 'agent:cody' } }))
      )
    ).toBe(false)
    expect(
      evaluateEventMatch(
        { origin: { kind: 'system' } },
        adaptWrkqWebhookEvent(event({ origin: { actor: 'system' } }))
      )
    ).toBe(true)
    expect(
      evaluateEventMatch(
        { origin: { kind: 'system' } },
        adaptWrkqWebhookEvent(event({ origin: { actor: 'system:wrkq-system' } }))
      )
    ).toBe(true)
  })

  test('"draft created by lance" composite match (the cody-review job)', () => {
    const draftByLance = adaptWrkqWebhookEvent(event({ transition: { from: null, to: 'draft' } }))
    const match = {
      event: 'created',
      transition: { to: 'draft' },
      origin: { actor: 'human:lance' },
    }
    expect(evaluateEventMatch(match, draftByLance)).toBe(true)
    // agent draft → no match
    expect(
      evaluateEventMatch(
        match,
        adaptWrkqWebhookEvent(
          event({ transition: { to: 'draft' }, origin: { actor: 'agent:rex' } })
        )
      )
    ).toBe(false)
    // lance but not draft → no match
    expect(
      evaluateEventMatch(match, adaptWrkqWebhookEvent(event({ transition: { to: 'open' } })))
    ).toBe(false)
  })

  test('matches generic subject.type and payload eq/anyOf/exists predicates', () => {
    const match = {
      event: 'transcript.completed',
      subject: { type: 'transcript' },
      origin: { kind: 'system' },
      payload: {
        backend: { eq: 'mlx' },
        model_id: { anyOf: ['voxtral', 'whisper'] },
        'nested.status': { exists: true },
      },
    }
    expect(evaluateEventMatch(match, acpEvent())).toBe(true)
    expect(evaluateEventMatch(match, acpEvent({ subject: { type: 'episode', id: 'ep_1' } }))).toBe(
      false
    )
    expect(evaluateEventMatch(match, acpEvent({ payload: { backend: 'other' } }))).toBe(false)
  })
})

describe('isAgentOriginEvent', () => {
  test('detects agent origin', () => {
    expect(
      isAgentOriginEvent(adaptWrkqWebhookEvent(event({ origin: { actor: 'agent:clod' } })))
    ).toBe(true)
    expect(
      isAgentOriginEvent(adaptWrkqWebhookEvent(event({ origin: { actor: 'human:lance' } })))
    ).toBe(false)
    expect(isAgentOriginEvent(adaptWrkqWebhookEvent(event({ origin: { actor: 'system' } })))).toBe(
      false
    )
  })
})

describe('resolveEventAction (fail-closed)', () => {
  test('resolves structural scopeRef + content templates', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: 'Research {{title}} ({{ticket_id}})' },
      event: adaptWrkqWebhookEvent(event()),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolved.scopeRef).toBe('agent:clod:project:agent-control-plane:task:T-00042')
      expect(result.resolved.laneRef).toBe('main')
      expect(result.resolved.input['content']).toBe('Research Investigate widget (T-00042)')
      expect(result.resolved.targetKey).toBe('T-00042')
    }
  })

  test('undefined structural var is a template_error (never empty string)', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: 'x' },
      event: adaptWrkqWebhookEvent(event({ ticket_id: undefined })),
    })
    expect(result.ok).toBe(false)
  })

  test('unknown template variable is rejected', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: 'Hello {{unknown_var}}' },
      event: adaptWrkqWebhookEvent(event()),
    })
    expect(result.ok).toBe(false)
  })

  test('resolved scopeRef is validated through the SessionRef parser', () => {
    const result = resolveEventAction({
      scopeRefTemplate: 'not a scope ref {{ticket_id}}',
      inputTemplate: { content: 'x' },
      event: adaptWrkqWebhookEvent(event()),
    })
    expect(result.ok).toBe(false)
  })

  test('untrusted title is capped but structural scopeRef never sees it', () => {
    const longTitle = 'A'.repeat(2000)
    const result = resolveEventAction({
      scopeRefTemplate: 'agent:clod:project:{{project_scope_id}}:task:{{ticket_id}}',
      inputTemplate: { content: '{{title}}' },
      event: adaptWrkqWebhookEvent(event({ title: longTitle })),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.resolved.input['content'] as string).length).toBeLessThanOrEqual(500)
    }
  })

  test('generic source denies payload in structural templates but allows capped payload content', () => {
    const denied = resolveEventAction({
      scopeRefTemplate: 'agent:mneme:project:{{payload.project}}:task:primary',
      inputTemplate: { content: 'x' },
      event: acpEvent({ payload: { project: 'media-ingest' } }),
    })
    expect(denied.ok).toBe(false)

    const resolved = resolveEventAction({
      scopeRefTemplate: 'agent:mneme:project:media-ingest:task:primary',
      inputTemplate: { content: 'Transcript {{payload.transcript_id}} via {{payload.backend}}' },
      event: acpEvent(),
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.resolved.scopeRef).toBe('agent:mneme:project:media-ingest:task:primary')
      expect(resolved.resolved.input['content']).toBe('Transcript tr_1 via mlx')
      expect(resolved.resolved.targetKey).toBe('transcript:tr_1')
    }
  })
})

describe('validateJobTrigger', () => {
  test('accepts a schedule trigger', () => {
    const result = validateJobTrigger({ kind: 'schedule', cron: '0 * * * *' })
    expect(result.valid).toBe(true)
  })

  test('accepts schedule catchUp policy on the trigger surface', () => {
    const result = validateJobTrigger({
      kind: 'schedule',
      cron: '0 8 * * 1-5',
      windowStart: '08:00',
      windowEnd: '18:00',
      windowMinutes: 30,
      catchUp: 'none',
    })

    expect(result.valid).toBe(true)
    if (result.valid) {
      // T-05419: catchUp is a first-class schedule policy, not an untyped blob
      // that the compiler/store silently drop before claimDueJobs can enforce it.
      expect(result.trigger).toEqual(
        expect.objectContaining({
          catchUp: 'none',
        })
      )
    }
  })

  test('accepts an event trigger with match and origin policy', () => {
    const result = validateJobTrigger({
      kind: 'event',
      source: 'wrkq',
      match: { event: 'created', transition: { to: 'idea' } },
      originPolicy: { agent: 'deny-self' },
      cooldown: '5m',
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.trigger.originPolicy?.agent).toBe('deny-self')
    }

    expect(
      validateJobTrigger({
        kind: 'event',
        source: 'wrkq',
        match: { event: 'created' },
        originPolicy: { agent: 'allow' },
      }).valid
    ).toBe(true)
  })

  test('accepts a generic event trigger source', () => {
    expect(
      validateJobTrigger({
        kind: 'event',
        source: 'media-ingest',
        match: {
          event: 'transcript.completed',
          subject: { type: 'transcript' },
          payload: { backend: { eq: 'mlx' } },
        },
      }).valid
    ).toBe(true)
  })

  test('rejects unknown kind and bad cooldown', () => {
    expect(validateJobTrigger({ kind: 'cron', cron: '0 * * * *' }).valid).toBe(false)
    expect(
      validateJobTrigger({ kind: 'event', source: 'wrkq', match: {}, cooldown: 'soon' }).valid
    ).toBe(false)
  })

  test('rejects invalid matcher syntax', () => {
    expect(
      validateJobTrigger({
        kind: 'event',
        source: 'media-ingest',
        match: { payload: { 'bad path': { eq: 'x' } } },
      }).valid
    ).toBe(false)
    expect(
      validateJobTrigger({
        kind: 'event',
        source: 'Media Ingest',
        match: {},
      }).valid
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
