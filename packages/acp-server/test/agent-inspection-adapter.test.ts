import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import {
  agentCatalogResponseSchema,
  agentInspectionOutcomeSchema,
  agentInspectionRequestSchema,
} from 'spaces-aspc-protocol/agent-inspection'

import { resolveAgentInspectionProjectRoot } from '../src/handlers/agent-inspection.js'
import type { AgentInspectionAuthority } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

const identity = {
  agentId: 'disk-agent',
  projectId: 'agent-control-plane',
  mode: 'task',
  scope: 'agent:disk-agent:project:agent-control-plane',
  lane: 'main',
  harness: 'codex',
  frontend: 'codex-cli',
  interaction: 'interactive',
}

const request = agentInspectionRequestSchema.parse({
  schemaVersion: 'agent-inspection-request/v1',
  identifiers: identity,
  declaredOverrides: {},
})

const neutralCatalog = agentCatalogResponseSchema.parse({
  projectId: null,
  agents: [
    {
      agentId: 'disk-agent',
      displayName: 'Disk Agent',
      role: 'implementation',
      sourceAvailability: { profile: true, soul: true, contextTemplate: true },
      diagnostics: [],
      warningCount: 0,
      errorCount: 0,
    },
  ],
  contexts: {},
})

const contextualCatalog = agentCatalogResponseSchema.parse({
  projectId: 'agent-control-plane',
  agents: [
    {
      ...neutralCatalog.agents[0],
      defaultContextSummary: {
        projectId: 'agent-control-plane',
        mode: 'task',
        lane: 'main',
        harness: 'codex',
        frontend: 'codex-cli',
        interaction: 'interactive',
      },
    },
  ],
  contexts: {
    'disk-agent': [{ identifiers: identity, declaredOverrides: {} }],
  },
})

const successfulOutcome = agentInspectionOutcomeSchema.parse({
  ok: true,
  inspection: {
    schemaVersion: 'agent-inspection/v1',
    identity,
    parts: [],
    completeness: { kind: 'complete' },
    freshness: { kind: 'unknown', reason: 'producer supplied no lock hash' },
    diagnostics: [],
  },
})

function fakeAuthority(
  overrides: Partial<AgentInspectionAuthority> = {}
): AgentInspectionAuthority {
  return {
    catalogAgentInspection: async ({ projectId }) =>
      projectId === undefined ? neutralCatalog : contextualCatalog,
    inspectAgentSelection: async () => successfulOutcome,
    ...overrides,
  }
}

describe('shared agent inspection adapter', () => {
  test('resolves project roots only from the trusted ACP project store', () => {
    const adminStore = createInMemoryAdminStore()
    adminStore.projects.create({
      projectId: 'agent-control-plane',
      displayName: 'Agent Control Plane',
      rootDir: '/trusted/agent-control-plane',
      actor: { kind: 'agent', id: 'test' },
      now: '2026-08-23T10:00:00.000Z',
    })

    expect(resolveAgentInspectionProjectRoot(adminStore, 'agent-control-plane')).toBe(
      '/trusted/agent-control-plane'
    )
    expect(resolveAgentInspectionProjectRoot(adminStore, '/client/supplied/root')).toBeUndefined()
    expect(resolveAgentInspectionProjectRoot(undefined, 'agent-control-plane')).toBeUndefined()
  })

  test('forwards only optional projectId and never caches the producer roster', async () => {
    const calls: unknown[] = []
    let catalog = neutralCatalog
    const authority = fakeAuthority({
      catalogAgentInspection: async (input) => {
        calls.push(input)
        return input.projectId === undefined ? catalog : contextualCatalog
      },
    })

    await withWiredServer(
      async (fixture) => {
        const first = await fixture.request({ method: 'GET', path: '/admin/agents' })
        expect(first.status).toBe(200)
        expect(await fixture.json(first)).toEqual(neutralCatalog)

        catalog = agentCatalogResponseSchema.parse({ projectId: null, agents: [], contexts: {} })
        const second = await fixture.request({ method: 'GET', path: '/admin/agents' })
        expect(second.status).toBe(200)
        expect(await fixture.json(second)).toEqual(catalog)

        const contextual = await fixture.request({
          method: 'GET',
          path: '/admin/agents?projectId=agent-control-plane',
        })
        expect(contextual.status).toBe(200)
        expect(await fixture.json(contextual)).toEqual(contextualCatalog)
        expect(calls).toEqual([{}, {}, { projectId: 'agent-control-plane' }])
      },
      { agentInspectionAuthority: authority }
    )
  })

  test('rejects path, environment, duplicate, and malformed catalog inputs before authority', async () => {
    let calls = 0
    const authority = fakeAuthority({
      catalogAgentInspection: async () => {
        calls += 1
        return neutralCatalog
      },
    })

    await withWiredServer(
      async (fixture) => {
        for (const path of [
          '/admin/agents?projectRoot=/tmp/project',
          '/admin/agents?environment=secret',
          '/admin/agents?projectId=one&projectId=two',
          '/admin/agents?projectId=/tmp/project',
        ]) {
          const response = await fixture.request({ method: 'GET', path })
          expect(response.status).toBe(400)
          expect((await fixture.json<{ error: { code: string } }>(response)).error.code).toBe(
            'invalid_agent_inspection_request'
          )
        }
        expect(calls).toBe(0)
      },
      { agentInspectionAuthority: authority }
    )
  })

  test('forwards the shared request unchanged and ignores ACP cwd and ambient environment', async () => {
    const calls: unknown[] = []
    const authority = fakeAuthority({
      inspectAgentSelection: async (input) => {
        calls.push(input)
        return successfulOutcome
      },
    })
    const previous = process.env['AGENT_INSPECTION_ADAPTER_SENTINEL']
    process.env['AGENT_INSPECTION_ADAPTER_SENTINEL'] = 'must-not-cross-the-wire'

    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: '/admin/agents/disk-agent/inspect',
            body: request,
          })
          expect(response.status).toBe(200)
          expect(await fixture.json(response)).toEqual(successfulOutcome)
          expect(calls).toEqual([{ agentId: 'disk-agent', request }])
          expect(JSON.stringify(calls)).not.toContain('AGENT_INSPECTION_ADAPTER_SENTINEL')
          expect(JSON.stringify(calls)).not.toContain(process.cwd())
        },
        { agentInspectionAuthority: authority }
      )
    } finally {
      if (previous === undefined) process.env['AGENT_INSPECTION_ADAPTER_SENTINEL'] = undefined
      else process.env['AGENT_INSPECTION_ADAPTER_SENTINEL'] = previous
    }
  })

  test('fails closed on route mismatch, unknown fields, and producer protocol drift', async () => {
    let calls = 0
    const authority = fakeAuthority({
      inspectAgentSelection: async () => {
        calls += 1
        return { unexpected: true } as never
      },
    })

    await withWiredServer(
      async (fixture) => {
        for (const body of [
          request,
          { ...request, cwd: '/tmp' },
          { ...request, environment: { TOKEN: 'secret' } },
        ]) {
          const response = await fixture.request({
            method: 'POST',
            path:
              body === request
                ? '/admin/agents/another-agent/inspect'
                : '/admin/agents/disk-agent/inspect',
            body,
          })
          expect(response.status).toBe(400)
        }

        const protocolFailure = await fixture.request({
          method: 'POST',
          path: '/admin/agents/disk-agent/inspect',
          body: request,
        })
        expect(protocolFailure.status).toBe(502)
        expect((await fixture.json<{ error: { code: string } }>(protocolFailure)).error.code).toBe(
          'agent_inspection_protocol_failure'
        )
        expect(calls).toBe(1)
      },
      { agentInspectionAuthority: authority }
    )
  })

  test('maps producer-declared failure to 502 and absence to 503 without empty success', async () => {
    const declaredFailure = agentInspectionOutcomeSchema.parse({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'unsupported_frontend',
          message: 'the selected frontend is unsupported',
        },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/admin/agents/disk-agent/inspect',
          body: request,
        })
        expect(response.status).toBe(502)
        expect(await fixture.json(response)).toEqual(declaredFailure)
      },
      {
        agentInspectionAuthority: fakeAuthority({
          inspectAgentSelection: async () => declaredFailure,
        }),
      }
    )

    await withWiredServer(async (fixture) => {
      const catalog = await fixture.request({ method: 'GET', path: '/admin/agents' })
      expect(catalog.status).toBe(503)
      expect((await fixture.json<{ error: { code: string } }>(catalog)).error.code).toBe(
        'agent_inspection_producer_unavailable'
      )
    })
  })

  test('preserves authority validation, not-found, producer-failure, and unavailable codes', async () => {
    const failures = [
      ['INVALID_AGENT_INSPECTION_SELECTION', 400],
      ['AGENT_INSPECTION_PROJECT_NOT_FOUND', 404],
      ['AGENT_INSPECTION_AGENT_NOT_FOUND', 404],
      ['AGENT_INSPECTION_PRODUCER_FAILURE', 502],
      ['AGENT_INSPECTION_PRODUCER_UNAVAILABLE', 503],
    ] as const

    for (const [code, status] of failures) {
      const error = Object.assign(new Error(code), { code, status })
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: '/admin/agents?projectId=agent-control-plane',
          })
          expect(response.status).toBe(status)
          expect((await fixture.json<{ error: { code: string } }>(response)).error.code).toBe(code)
        },
        {
          agentInspectionAuthority: fakeAuthority({
            catalogAgentInspection: async () => Promise.reject(error),
          }),
        }
      )
    }
  })

  test('keeps the canonical disk roster separate from ACP-only rows and optional dossier 404', async () => {
    const adminStore = createInMemoryAdminStore()
    adminStore.agents.create({
      agentId: 'admin-only',
      displayName: 'Admin Only',
      status: 'active',
      actor: { kind: 'agent', id: 'test' },
      now: '2026-08-23T10:00:00.000Z',
    })

    await withWiredServer(
      async (fixture) => {
        const catalog = await fixture.request({ method: 'GET', path: '/admin/agents' })
        expect(catalog.status).toBe(200)
        const body = await fixture.json<typeof neutralCatalog>(catalog)
        expect(body.agents.map((agent) => agent.agentId)).toEqual(['disk-agent'])

        const diskDossier = await fixture.request({
          method: 'GET',
          path: '/v1/admin/agents/disk-agent/detail',
        })
        expect(diskDossier.status).toBe(404)

        const adminDossier = await fixture.request({
          method: 'GET',
          path: '/v1/admin/agents/admin-only/detail',
        })
        expect(adminDossier.status).toBe(200)
      },
      { adminStore, agentInspectionAuthority: fakeAuthority() }
    )
  })
})
