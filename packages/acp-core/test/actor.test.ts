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
})
