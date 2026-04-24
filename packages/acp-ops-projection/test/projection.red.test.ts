import { describe, expect, test } from 'bun:test'
import {
  type HrcLifecycleEvent,
  defaultRedactionOptions,
  deriveSessionRow,
  projectHrcToDashboardEvent,
  redactPayload,
} from '../src/index.js'

const baseEvent = (overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent => ({
  hrcSeq: 100,
  ts: '2026-04-23T23:46:51.000Z',
  sessionRef: {
    scopeRef: 'project:agent-spaces',
    laneRef: 'main',
  },
  hostSessionId: 'host-session-1',
  generation: 1,
  eventKind: 'runtime.status',
  category: 'runtime',
  payload: {},
  ...overrides,
})

describe('session dashboard projection red contract', () => {
  test.each([
    ['category runtime', baseEvent({ category: 'runtime' }), 'runtime'],
    ['category launch', baseEvent({ category: 'launch' }), 'runtime'],
    ['turn accepted', baseEvent({ category: undefined, eventKind: 'turn.accepted' }), 'runtime'],
    [
      'message start',
      baseEvent({ category: undefined, payload: { type: 'message_start' } }),
      'agent_message',
    ],
    [
      'message update',
      baseEvent({ category: undefined, payload: { type: 'message_update' } }),
      'agent_message',
    ],
    [
      'message end',
      baseEvent({ category: undefined, payload: { type: 'message_end' } }),
      'agent_message',
    ],
    [
      'tool execution start',
      baseEvent({ category: undefined, payload: { type: 'tool_execution_start' } }),
      'tool',
    ],
    [
      'tool execution update',
      baseEvent({ category: undefined, payload: { type: 'tool_execution_update' } }),
      'tool',
    ],
    [
      'tool execution end',
      baseEvent({ category: undefined, payload: { type: 'tool_execution_end' } }),
      'tool',
    ],
    [
      'inflight event kind',
      baseEvent({ category: undefined, eventKind: 'inflight.accepted' }),
      'input',
    ],
    [
      'user input payload',
      baseEvent({ category: undefined, payload: { type: 'user_input_delta' } }),
      'input',
    ],
    [
      'delivery event kind',
      baseEvent({ category: undefined, eventKind: 'gateway.delivery.sent' }),
      'delivery',
    ],
    [
      'handoff event kind',
      baseEvent({ category: undefined, eventKind: 'coordination.handoff.wake' }),
      'handoff',
    ],
    ['category surface', baseEvent({ category: 'surface' }), 'surface'],
    ['category context', baseEvent({ category: 'context' }), 'context'],
    ['error code', baseEvent({ category: undefined, payload: { errorCode: 'E_FAIL' } }), 'warning'],
    [
      'rejection kind',
      baseEvent({ category: undefined, eventKind: 'runtime.rejected' }),
      'warning',
    ],
  ])('maps %s to dashboard family %s per spec section 9', (_name, event, family) => {
    // T-01201 red test: every row in SESSION_DASHBOARD.md §9 must be projected.
    expect(projectHrcToDashboardEvent(event).family).toBe(family)
  })

  test('payload.type takes precedence over category when both are present', () => {
    // T-01201 red test: SESSION_DASHBOARD.md §9 says payload-derived family wins.
    const projected = projectHrcToDashboardEvent(
      baseEvent({ category: 'runtime', payload: { type: 'tool_execution_start' } })
    )

    expect(projected.family).toBe('tool')
  })

  test('event id is stable across replay using hrcSeq', () => {
    // T-01201 red test: SESSION_DASHBOARD.md §8.4 requires HRC ids to be hrc:<hrcSeq>.
    const projected = projectHrcToDashboardEvent(baseEvent({ hrcSeq: 4729 }))

    expect(projected.id).toBe('hrc:4729')
  })

  test.each([
    ['payload errorCode', baseEvent({ payload: { errorCode: 'E_TOOL' } }), 'error'],
    ['warning event kind', baseEvent({ eventKind: 'runtime.warning' }), 'warning'],
    ['successful completion', baseEvent({ eventKind: 'message.end' }), 'success'],
    ['ordinary event', baseEvent({ eventKind: 'runtime.status' }), 'info'],
  ])('derives severity for %s', (_name, event, severity) => {
    // T-01201 red test: dashboard severity must be stable for visual status.
    expect(projectHrcToDashboardEvent(event).severity).toBe(severity)
  })

  test('rowId is hostSessionId:generation and differs across generations', () => {
    // T-01201 red test: SESSION_DASHBOARD.md §8.3 requires generation in rowId.
    const first = projectHrcToDashboardEvent(baseEvent({ hostSessionId: 'host-a', generation: 1 }))
    const second = projectHrcToDashboardEvent(baseEvent({ hostSessionId: 'host-a', generation: 2 }))

    expect(deriveSessionRow([first], 90_000).rowId).toBe('host-a:1')
    expect(deriveSessionRow([second], 90_000).rowId).toBe('host-a:2')
    expect(deriveSessionRow([first], 90_000).rowId).not.toBe(
      deriveSessionRow([second], 90_000).rowId
    )
  })
})

describe('session dashboard redaction red contract', () => {
  test('exports the section 16 recommended redaction defaults', () => {
    // T-01201 red test: defaults are part of the public projection contract.
    expect(defaultRedactionOptions).toEqual({
      payloadPreviewTextLimit: 240,
      payloadPreviewObjectDepth: 3,
      payloadPreviewArrayLimit: 20,
      rawPayloadDebug: false,
    })
  })

  test('redacts credential-like keys at any depth', () => {
    // T-01201 red test: SESSION_DASHBOARD.md §16 credential keys must be stripped.
    const sensitive = {
      token: 'token-value',
      nested: {
        secret: 'secret-value',
        password: 'password-value',
        cookie: 'cookie-value',
        bearer: 'bearer-value',
        api_key: 'api-key-value',
        access_key: 'access-key-value',
        refresh_token: 'refresh-token-value',
      },
      safe: 'visible',
    }

    expect(redactPayload(sensitive).payloadPreview).toEqual({
      token: '[REDACTED]',
      nested: {
        secret: '[REDACTED]',
        password: '[REDACTED]',
        cookie: '[REDACTED]',
        bearer: '[REDACTED]',
        api_key: '[REDACTED]',
        access_key: '[REDACTED]',
        refresh_token: '[REDACTED]',
      },
      safe: 'visible',
    })
  })

  test('truncates long strings to the default 240 character preview limit', () => {
    // T-01201 red test: SESSION_DASHBOARD.md §16 caps message previews.
    const preview = redactPayload('x'.repeat(260)).payloadPreview

    expect(preview).toBe(`${'x'.repeat(240)}...`)
  })

  test('caps object depth at 3 and array length at 20', () => {
    // T-01201 red test: browser payload previews must remain bounded by §16.
    const payload = {
      level1: {
        level2: {
          level3: {
            level4: 'hidden',
          },
        },
      },
      items: Array.from({ length: 25 }, (_, index) => index),
    }

    expect(redactPayload(payload).payloadPreview).toEqual({
      level1: {
        level2: {
          level3: '[MaxDepth]',
        },
      },
      items: Array.from({ length: 20 }, (_, index) => index),
    })
  })

  test('rawPayloadDebug=true returns an unredacted preview', () => {
    // T-01201 red test: raw payload access is explicit and default-off.
    const payload = {
      token: 'visible-in-debug',
      nested: {
        value: 'x'.repeat(260),
      },
    }

    expect(redactPayload(payload, { rawPayloadDebug: true })).toEqual({
      payloadPreview: payload,
      redacted: false,
    })
  })
})
