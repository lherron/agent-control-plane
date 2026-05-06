import { describe, expect, test } from 'bun:test'

type SessionRef = {
  scopeRef: string
  laneRef?: string | undefined
}

async function loadIdentityModule(): Promise<{
  identityFromSessionRef: (sessionRef: SessionRef) => {
    agentId: string
    scopeRef: string
    laneRef?: string | undefined
  }
  formatSessionSubtext: (sessionRef: SessionRef) => string
  avatarFor: (agentId: string) => string
}> {
  return import('../identity.js')
}

describe('Discord agent identity helpers', () => {
  test('identityFromSessionRef extracts the agent id from canonical scopeRef', async () => {
    const { identityFromSessionRef } = await loadIdentityModule()

    expect(
      identityFromSessionRef({
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
        laneRef: 'main',
      })
    ).toEqual({
      agentId: 'cody',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
      laneRef: 'main',
    })
  })

  test('formatSessionSubtext renders project, task, and lane variants', async () => {
    const { formatSessionSubtext } = await loadIdentityModule()

    expect(
      formatSessionSubtext({
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
        laneRef: 'main',
      })
    ).toBe('cody@agent-spaces:T-04321~main')
    expect(
      formatSessionSubtext({
        scopeRef: 'agent:cody:project:agent-spaces',
        laneRef: 'main',
      })
    ).toBe('cody@agent-spaces~main')
    expect(
      formatSessionSubtext({
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
      })
    ).toBe('cody@agent-spaces:T-04321')
    expect(formatSessionSubtext({ scopeRef: 'agent:cody' })).toBe('cody')
  })

  test('avatarFor returns a deterministic public dicebear URL seeded by agent id', async () => {
    const { avatarFor } = await loadIdentityModule()

    expect(avatarFor('cody')).toBe('https://api.dicebear.com/7.x/bottts/png?seed=cody')
    expect(avatarFor('larry')).toBe('https://api.dicebear.com/7.x/bottts/png?seed=larry')
    expect(avatarFor('cody')).toBe(avatarFor('cody'))
  })
})
