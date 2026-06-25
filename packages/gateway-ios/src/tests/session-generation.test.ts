import { describe, expect, it } from 'bun:test'
import type { HrcSessionRecord } from 'hrc-core'

import { resolveSessionGeneration } from '../session-generation.js'

const SESSION_REF = 'agent:cody:project:agent-spaces/lane:main'
const SCOPE_REF = 'agent:cody:project:agent-spaces'

function session(overrides: Partial<HrcSessionRecord> = {}): HrcSessionRecord {
  return {
    hostSessionId: 'host-main',
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-04-30T10:00:00.000Z',
    updatedAt: '2026-04-30T10:00:00.000Z',
    ancestorScopeRefs: [],
    ...overrides,
  }
}

describe('session generation resolution', () => {
  it('breaks equal-generation ties by updatedAt', async () => {
    const sessions = [
      session({
        hostSessionId: 'host-older',
        generation: 3,
        updatedAt: '2026-04-30T10:00:00.000Z',
      }),
      session({
        hostSessionId: 'host-newer',
        generation: 3,
        updatedAt: '2026-04-30T10:05:00.000Z',
      }),
    ]

    const selected = await resolveSessionGeneration(
      {
        async listSessions() {
          return sessions
        },
      },
      { sessionRef: SESSION_REF }
    )

    expect(selected.hostSessionId).toBe('host-newer')
    expect(selected.generation).toBe(3)
  })
})
