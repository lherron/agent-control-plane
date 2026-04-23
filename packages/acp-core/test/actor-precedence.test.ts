import { describe, expect, test } from 'bun:test'

import { parseActorFromHeaders } from '../src/index.js'

describe('actor precedence parsing', () => {
  test('prefers X-ACP-Actor kind:id header values over body and env default', () => {
    expect(
      parseActorFromHeaders(
        new Headers({ 'x-acp-actor': 'agent:curly' }),
        { actor: { kind: 'human', id: 'body-operator' } },
        { kind: 'system', id: 'acp-local' }
      )
    ).toEqual({ kind: 'agent', id: 'curly' })
  })

  test('accepts JSON-in-header actor values', () => {
    expect(
      parseActorFromHeaders(
        new Headers({
          'x-acp-actor': JSON.stringify({
            kind: 'human',
            id: 'header-human',
            displayName: 'Header',
          }),
        }),
        {},
        { kind: 'system', id: 'acp-local' }
      )
    ).toEqual({ kind: 'human', id: 'header-human', displayName: 'Header' })
  })

  test('falls back to body actor then env default', () => {
    expect(
      parseActorFromHeaders(
        new Headers(),
        { actor: { kind: 'human', id: 'body-operator' } },
        { kind: 'system', id: 'acp-local' }
      )
    ).toEqual({ kind: 'human', id: 'body-operator' })

    expect(parseActorFromHeaders(new Headers(), {}, { kind: 'system', id: 'acp-local' })).toEqual({
      kind: 'system',
      id: 'acp-local',
    })
  })

  test('rejects unknown actor kinds with a validation error', () => {
    expect(() =>
      parseActorFromHeaders(
        new Headers({ 'x-acp-actor': 'robot:hal-9000' }),
        {},
        { kind: 'system', id: 'acp-local' }
      )
    ).toThrow(/kind/i)
  })
})
