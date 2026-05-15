import { describe, expect, test } from 'bun:test'
import type { AdminAgentProfile } from 'acp-core'

import { createHttpClient } from '../src/http-client.js'
import { createFetchQueue } from './cli-test-helpers.js'

type AgentProfilePatchPayload = {
  displayColor?: string | null | undefined
  monogram?: string | null | undefined
  avatarUrl?: string | null | undefined
  tagline?: string | null | undefined
  role?: string | null | undefined
  defaultModel?: string | null | undefined
  vibe?: string[] | null | undefined
  specialties?: string[] | null | undefined
}

type AgentProfileClientSurface = {
  patchAgentProfile(input: {
    actorAgentId: string
    agentId: string
    profile: AgentProfilePatchPayload
  }): Promise<{ agent: { agentId: string; profile?: AdminAgentProfile | undefined } }>
}

describe('ACP HTTP client agent profile surface', () => {
  test('patchAgentProfile sends PATCH to the profile route with null-clears preserved', async () => {
    const queue = createFetchQueue([
      {
        body: {
          agent: {
            agentId: 'smokey',
            profile: {
              tagline: 'Red/green validator',
              vibe: ['precise'],
            },
          },
        },
        assert(request) {
          expect(request.method).toBe('PATCH')
          expect(new URL(request.url).pathname).toBe('/v1/admin/agents/smokey/profile')
          expect(request.headers.get('x-acp-actor-agent-id')).toBe('smokey')
          expect(request.body).toEqual({
            tagline: 'Red/green validator',
            displayColor: null,
            vibe: ['precise'],
            actor: { kind: 'agent', id: 'smokey' },
          })
        },
      },
    ])
    const client = createHttpClient({ fetchImpl: queue.fetchImpl }) as ReturnType<
      typeof createHttpClient
    > &
      AgentProfileClientSurface

    const response = await client.patchAgentProfile({
      actorAgentId: 'smokey',
      agentId: 'smokey',
      profile: {
        tagline: 'Red/green validator',
        displayColor: null,
        vibe: ['precise'],
      },
    })

    expect(response.agent.profile).toEqual({
      tagline: 'Red/green validator',
      vibe: ['precise'],
    })
  })
})
