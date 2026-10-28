import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryAdminStore } from 'acp-admin-store'
import {
  agentCatalogResponseSchema,
  agentInspectionOutcomeSchema,
  agentInspectionRequestSchema,
} from 'spaces-aspc-protocol/agent-inspection'

import { createAspcService } from 'spaces-aspc'

import { createAgentInspectionProjectRootResolver } from '../src/handlers/agent-inspection.js'
import type { AgentInspectionAuthority } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

const identity = {
  agentId: 'disk-agent',
  projectId: 'agent-control-plane',
  mode: 'task',
  scope: 'agent:disk-agent:project:agent-control-plane',
  lane: 'main',
  harness: 'codex',
  presentation: false,
}

const request = agentInspectionRequestSchema.parse({
  schemaVersion: 'agent-inspection-request/v2',
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
        presentation: false,
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
    schemaVersion: 'agent-inspection/v2',
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
  test('resolves project ids absent from the admin store the way placement does', async () => {
    // Production shape (T-12021): the admin store knows none of these projects;
    // placement finds them through the wrkq registry and the checkout scan.
    const scratch = mkdtempSync(join(tmpdir(), 'acp-inspect-roots-'))
    try {
      const agentsRoot = join(scratch, 'agents')
      const searchRoot = join(scratch, 'praesidium')
      const registeredRoot = join(scratch, 'elsewhere', 'loggia-checkout')
      const scannedRoot = join(searchRoot, 'hrc-runtime')
      for (const dir of [agentsRoot, join(registeredRoot, '.git'), join(scannedRoot, '.git')]) {
        mkdirSync(dir, { recursive: true })
      }
      const resolveProjectRoot = createAgentInspectionProjectRootResolver({
        adminStore: createInMemoryAdminStore(),
        loadRegistryProjects: async () => [
          { slug: 'loggia', path: 'loggia', title: 'loggia', root: registeredRoot },
          { slug: 'hrc-runtime', path: 'hrc-runtime', title: 'hrc-runtime', root: null },
        ],
        env: { HOME: scratch, HRC_PROJECT_SEARCH_ROOTS: searchRoot },
        cwd: scratch,
      })
      const service = createAspcService({ agentsRoot, resolveProjectRoot })

      await withWiredServer(
        async (fixture) => {
          for (const projectId of ['loggia', 'hrc-runtime']) {
            const response = await fixture.request({
              method: 'GET',
              path: `/admin/agents?projectId=${projectId}`,
            })
            expect({ projectId, status: response.status }).toEqual({ projectId, status: 200 })
            expect((await fixture.json(response)) as { projectId: string }).toMatchObject({
              projectId,
            })
          }

          const unknown = await fixture.request({
            method: 'GET',
            path: '/admin/agents?projectId=no-such-project',
          })
          expect(unknown.status).toBe(404)
        },
        { agentInspectionAuthority: service }
      )
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('an explicit admin-store root still wins and client paths never resolve', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'acp-inspect-roots-'))
    try {
      const registeredRoot = join(scratch, 'registered')
      mkdirSync(join(registeredRoot, '.git'), { recursive: true })
      const adminStore = createInMemoryAdminStore()
      adminStore.projects.create({
        projectId: 'agent-control-plane',
        displayName: 'Agent Control Plane',
        rootDir: '/trusted/agent-control-plane',
        actor: { kind: 'agent', id: 'test' },
        now: '2026-08-23T10:00:00.000Z',
      })
      const resolve = createAgentInspectionProjectRootResolver({
        adminStore,
        loadRegistryProjects: async () => [
          { slug: 'agent-control-plane', path: 'agent-control-plane', root: registeredRoot },
        ],
        env: { HOME: scratch, HRC_PROJECT_SEARCH_ROOTS: scratch },
        cwd: scratch,
      })

      expect(await resolve('agent-control-plane')).toBe('/trusted/agent-control-plane')
      expect(await resolve(registeredRoot)).toBeUndefined()
      expect(await resolve('../registered')).toBeUndefined()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
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
        const rows = [
          {
            name: 'route agent differs from identifiers.agentId',
            path: '/admin/agents/another-agent/inspect',
            body: request,
            message: 'identifiers.agentId must match the route agentId',
            offending: undefined,
          },
          {
            name: 'unknown cwd field',
            path: '/admin/agents/disk-agent/inspect',
            body: { ...request, cwd: '/tmp' },
            message: 'Agent inspection request is invalid',
            offending: 'cwd',
          },
          {
            name: 'unknown environment field',
            path: '/admin/agents/disk-agent/inspect',
            body: { ...request, environment: { TOKEN: 'secret' } },
            message: 'Agent inspection request is invalid',
            offending: 'environment',
          },
        ]
        for (const row of rows) {
          const response = await fixture.request({
            method: 'POST',
            path: row.path,
            body: row.body,
          })
          expect(response.status, row.name).toBe(400)
          const { error } = await fixture.json<{
            error: { code: string; message: string; details?: unknown }
          }>(response)
          expect(error.code, row.name).toBe('invalid_agent_inspection_request')
          expect(error.message, row.name).toBe(row.message)
          if (row.offending !== undefined) {
            expect(JSON.stringify(error.details), row.name).toContain(row.offending)
          }
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
