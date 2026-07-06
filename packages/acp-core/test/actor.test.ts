import { parseActorFromHeaders } from '../src/index.js'

describe('parseActorFromHeaders', () => {
  test('prefers the x-acp-actor header', () => {
    const actor = parseActorFromHeaders(
      new Headers({
        'x-acp-actor': JSON.stringify({ kind: 'agent', id: 'header-agent', displayName: 'Header' }),
      }),
      {
        actor: { kind: 'human', id: 'body-human' },
      },
      { kind: 'system', id: 'env-system' }
    )

    expect(actor).toEqual({ kind: 'agent', id: 'header-agent', displayName: 'Header' })
  })

  test('falls back to the request body then env default', () => {
    expect(
      parseActorFromHeaders(
        new Headers(),
        { actor: { kind: 'human', id: 'body-human' } },
        {
          kind: 'system',
          id: 'env-system',
        }
      )
    ).toEqual({ kind: 'human', id: 'body-human' })

    expect(parseActorFromHeaders(new Headers(), {}, { kind: 'system', id: 'env-system' })).toEqual({
      kind: 'system',
      id: 'env-system',
    })
  })

  test('rejects array actor body values as non-object actors', () => {
    expect(() => parseActorFromHeaders(new Headers(), { actor: [] })).toThrow(
      /actor must be an object/i
    )
  })

  test('keeps array x-acp-actor header values outside the JSON grammar', () => {
    expect(() =>
      parseActorFromHeaders(new Headers({ 'x-acp-actor': JSON.stringify([]) }), {})
    ).toThrow(/kind:id or JSON/i)
  })
})
