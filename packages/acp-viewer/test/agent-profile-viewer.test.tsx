import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AgentEntry } from '../src/features/agents/components/agent-entry'
import type { AgentSummary } from '../src/types/api'

type AgentEntryRow = AgentSummary & {
  heartbeat: string
  membershipsCount: number | undefined
  defaultProjectCount: number | undefined
  assignedJobsCount: number | undefined
}

const BASE_AGENT = {
  homeDir: '/Users/lherron/praesidium/var/agents/smokey',
  status: 'active',
  createdAt: '2026-05-15T00:00:00.000Z',
  updatedAt: '2026-05-15T00:00:00.000Z',
  createdBy: 'test',
  updatedBy: 'test',
  heartbeat: 'alive',
  membershipsCount: 1,
  defaultProjectCount: 0,
  assignedJobsCount: 2,
} satisfies Omit<AgentEntryRow, 'agentId' | 'displayName'>

function renderAgentEntry(row: AgentEntryRow): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AgentEntry row={row} index={0} total={1} />
    </MemoryRouter>
  )
}

describe('agent profile viewer integration', () => {
  it('renders display color and tagline from the API profile on AgentEntry', () => {
    const html = renderAgentEntry({
      ...BASE_AGENT,
      agentId: 'smokey',
      displayName: 'Smokey Validator',
      profile: {
        displayColor: '#2A7FFF',
        monogram: 'SV',
        tagline: 'E2E validator',
        vibe: ['skeptical', 'precise'],
        role: 'red/green gatekeeper',
        defaultModel: 'gpt-5-codex',
        specialties: ['smoke', 'regression'],
      },
    })

    expect(html).toContain('E2E validator')
    expect(html).toContain('#2A7FFF')
    expect(html).toContain('red/green gatekeeper')
    expect(html).toContain('gpt-5-codex')
  })

  it('renders the derived fallback profile when the API profile is absent', async () => {
    const { deriveFallbackProfile } = await import('../src/features/agents/personality')
    const row = {
      ...BASE_AGENT,
      agentId: 'mira',
      displayName: 'Mira Frost',
    }
    const fallback = deriveFallbackProfile(row.agentId, row.displayName)
    const html = renderAgentEntry(row)

    expect(html).toContain(fallback.tagline)
    expect(html).toContain(fallback.color)
    expect(html).toContain(fallback.monogram)
  })
})
