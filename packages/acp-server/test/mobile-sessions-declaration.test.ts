import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import {
  BASE_SCOPE_REF,
  REQUEST_ID,
  TEST_AGENT_ROOT,
  createMobileSessionHrcClient,
  defaultDeclarationResolution,
  withMobileSessionServer,
} from './fixtures/mobile-session-creation.js'

describe('POST /v1/mobile/sessions declaration resolution (T-08572)', () => {
  test.each(['opus', 'fable', 'sol', 'astra'])(
    'passes %s through HRC declaration as a summon directive',
    async (model) => {
      const fixture = createMobileSessionHrcClient({
        resolveImpl: (request) => {
          const resolved = defaultDeclarationResolution(request)
          return {
            ...resolved,
            intent: { ...resolved.intent, provision: { model }, summonDirectives: { model } },
          }
        },
      })
      await withMobileSessionServer(async ({ post }) => {
        const response = await post({ model })
        expect(response.status).toBe(200)
        expect(fixture.resolveCalls[0]).toMatchObject({ provision: { model } })
        expect(fixture.starts[0]?.runtimeIntent).toMatchObject({
          summonDirectives: { model },
          provision: { model },
        })
      }, fixture.client)
    }
  )

  test('refuses to start when HRC does not return the requested summon directive', async () => {
    const fixture = createMobileSessionHrcClient()
    await withMobileSessionServer(async ({ post }) => {
      const response = await post({ model: 'sol' })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(fixture.starts).toHaveLength(0)
    }, fixture.client)
  })

  test("U-1: resolves with exactly today's inputs and no extra keys", async () => {
    const { client, resolveCalls, starts } = createMobileSessionHrcClient()
    await withMobileSessionServer(async ({ post }) => {
      const response = await post()
      expect(response.status).toBe(200)
      expect(resolveCalls).toHaveLength(1)
      expect(resolveCalls[0]).toEqual({
        agentId: 'mable',
        agentRoot: TEST_AGENT_ROOT,
        projectRoot: '/tmp/praesidium-test-projects/hrc-runtime',
        cwd: '/tmp/praesidium-test-projects/hrc-runtime',
        runMode: 'task',
        interactive: true,
        preferredMode: 'headless',
      })
      expect(starts).toHaveLength(1)
    }, client)
  })

  test('U-1: forwards agentSources only when deps define them', async () => {
    for (const hrcAgentSources of [
      undefined,
      { agentsRoot: TEST_AGENT_ROOT, aspHome: tmpdir() },
    ] as const) {
      const { client, resolveCalls } = createMobileSessionHrcClient()
      await withMobileSessionServer(
        async ({ post }) => {
          const response = await post()
          expect(response.status).toBe(200)
          expect(resolveCalls).toHaveLength(1)
          if (hrcAgentSources === undefined) {
            expect(resolveCalls[0]).not.toHaveProperty('agentSources')
          } else {
            expect(resolveCalls[0]).toMatchObject({ agentSources: hrcAgentSources })
          }
        },
        client,
        hrcAgentSources
      )
    }
  })

  test('U-2: takes only harness/execution; placement, bundle and correlation stay base', async () => {
    const sentinelPlacement = {
      agentRoot: TEST_AGENT_ROOT,
      projectRoot: '/sentinel-root',
      cwd: '/sentinel-cwd',
      bundle: { kind: 'sentinel' },
      correlation: { sessionRef: { scopeRef: 'agent:sentinel:project:x:task:y', laneRef: 'main' } },
    }
    const { client, starts } = createMobileSessionHrcClient({
      resolveImpl: (request) => ({
        ...defaultDeclarationResolution(request),
        intent: {
          harness: { provider: 'sentinel', interactive: false },
          execution: { preferredMode: 'interactive' },
          placement: sentinelPlacement,
        },
      }),
    })
    await withMobileSessionServer(async ({ post }) => {
      const response = await post()
      expect(response.status).toBe(200)
      expect(starts).toHaveLength(1)
      const runtimeIntent = starts[0]?.runtimeIntent as unknown as Record<string, unknown>
      expect(runtimeIntent['harness']).toEqual({ provider: 'sentinel', interactive: false })
      expect(runtimeIntent['execution']).toEqual({ preferredMode: 'interactive' })
      const placement = runtimeIntent['placement'] as Record<string, unknown>
      expect(placement['agentRoot']).toBe(TEST_AGENT_ROOT)
      expect(placement['projectRoot']).toBe('/tmp/praesidium-test-projects/hrc-runtime')
      expect(placement['cwd']).toBe('/tmp/praesidium-test-projects/hrc-runtime')
      expect(JSON.stringify(placement)).not.toContain('sentinel')
      expect(placement['correlation']).toEqual({
        sessionRef: { scopeRef: BASE_SCOPE_REF, laneRef: 'main' },
      })
    }, client)
  })

  test.each([
    [
      'F1a',
      new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'aspd down', {
        code: 'aspd_unavailable',
      }),
      503,
      'runtime_unavailable',
    ],
    [
      'F1b',
      new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'aspd speaks another protocol', {
        code: 'aspd_protocol_incompatible',
      }),
      503,
      'runtime_unavailable',
    ],
    [
      'F2',
      new HrcDomainError(
        HrcErrorCode.RUNTIME_UNAVAILABLE,
        'HRC daemon unreachable at /tmp/hrc.sock',
        { code: 'hrc_daemon_unreachable', socketPath: '/tmp/hrc.sock' }
      ),
      503,
      'runtime_unavailable',
    ],
    [
      'F3',
      new HrcDomainError(
        HrcErrorCode.UNSUPPORTED_CAPABILITY,
        'HRC daemon does not serve declaration resolution',
        { capability: 'declarations.resolve', route: '/v1/declarations/resolve' }
      ),
      422,
      'unsupported_capability',
    ],
    [
      'F4',
      new HrcDomainError(HrcErrorCode.DECLARATION_INVALID, 'invalid targets', {
        source: 'asp-targets',
        producerCode: 'bad',
        diagnostics: [],
      }),
      422,
      'declaration_invalid',
    ],
    [
      'F5',
      new HrcDomainError(HrcErrorCode.MALFORMED_REQUEST, 'incoherent context', {
        code: 'configured_context_mismatch',
        route: 'aspd',
      }),
      400,
      'malformed_request',
    ],
  ] as const)(
    'U-4: %s sends no start and labels the nested envelope not_claimed',
    async (_id, error, status, code) => {
      const { client, starts } = createMobileSessionHrcClient({ resolveError: error })
      await withMobileSessionServer(async ({ post, json }) => {
        const response = await post()
        expect(response.status).toBe(status)
        expect(await json(response)).toEqual({
          error: {
            code,
            message: error.message,
            details: {
              ...(error.detail as Record<string, unknown>),
              stage: 'declaration',
              attemptState: 'not_claimed',
              requestId: REQUEST_ID,
            },
          },
        })
        expect(starts).toHaveLength(0)
      }, client)
    }
  )

  test("U-5: a non-domain rejection keeps today's 500 projection with zero starts", async () => {
    const { client, starts } = createMobileSessionHrcClient({
      resolveError: new Error('socket hangup'),
    })
    await withMobileSessionServer(async ({ post, json }) => {
      const response = await post()
      expect(response.status).toBe(500)
      expect(await json(response)).toMatchObject({ error: { code: 'internal_error' } })
      expect(starts).toHaveLength(0)
    }, client)
  })

  test('U-6: a declaration warning is logged verbatim once, before HRC is asked to start', async () => {
    const order: string[] = []
    const errorLog = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('mobile.session.declaration_warning')) order.push('warn')
    })
    try {
      const { client, starts } = createMobileSessionHrcClient({
        onStart: () => order.push('start'),
        resolveImpl: (request) => {
          const resolved = defaultDeclarationResolution(request)
          resolved.declaration.warnings = [
            '[hrc-core] WARN agent.provisioning.stripped — agent "mable" (target harness only)',
          ]
          return resolved
        },
      })
      const loggedErrors = errorLog as unknown as { mock: { calls: unknown[][] } }
      await withMobileSessionServer(async ({ post }) => {
        const response = await post()
        expect(response.status).toBe(200)
        expect(starts).toHaveLength(1)
        const warnings = loggedErrors.mock.calls
          .map((call) => JSON.parse(String(call[0])))
          .filter((line) => line.event === 'mobile.session.declaration_warning')
          .map((line) => line.data.warning)
        expect(warnings).toContain(
          '[hrc-core] WARN agent.provisioning.stripped — agent "mable" (target harness only)'
        )
        expect(order).toEqual(['warn', 'start'])
      }, client)
      const lines = loggedErrors.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('agent.provisioning.stripped'))
      expect(lines).toHaveLength(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  test.each([
    ['daemon-default', { provenance: 'daemon-default' }],
    ['project-marker', { provenance: 'project-marker' }],
    ['caller-asp-home-config', { provenance: 'caller-asp-home-config' }],
  ] as const)('U-7a: provenance %s fails closed with no label', async (_id, agentSources) => {
    const { client, starts } = createMobileSessionHrcClient({
      resolveImpl: (request) => {
        const resolved = defaultDeclarationResolution(request)
        return {
          ...resolved,
          declaration: {
            ...resolved.declaration,
            agentSources,
          },
        }
      },
    })
    await withMobileSessionServer(
      async ({ post, json }) => {
        const response = await post()
        expect(response.status).toBe(500)
        const body = await json<{ error: { code: string; details?: Record<string, unknown> } }>(
          response
        )
        expect(body.error.code).toBe('internal_error')
        expect(body.error.details ?? {}).not.toHaveProperty('attemptState')
        expect(starts).toHaveLength(0)
      },
      client,
      { agentsRoot: TEST_AGENT_ROOT, aspHome: tmpdir() }
    )
  })

  test('U-7a: a sent key missing from the echo fails closed', async () => {
    const { client, starts } = createMobileSessionHrcClient({
      resolveImpl: (request) => {
        const resolved = defaultDeclarationResolution(request)
        return {
          ...resolved,
          declaration: {
            ...resolved.declaration,
            agentSources: { agentsRoot: TEST_AGENT_ROOT, provenance: 'caller-agent-root' },
          },
        }
      },
    })
    await withMobileSessionServer(
      async ({ post, json }) => {
        const response = await post()
        expect(response.status).toBe(500)
        expect((await json<{ error: { code: string } }>(response)).error.code).toBe(
          'internal_error'
        )
        expect(starts).toHaveLength(0)
      },
      client,
      { agentsRoot: TEST_AGENT_ROOT, aspHome: tmpdir() }
    )
  })

  test('U-7a: a substituted echo path fails closed', async () => {
    const { client, starts } = createMobileSessionHrcClient({
      resolveImpl: (request) => {
        const resolved = defaultDeclarationResolution(request)
        return {
          ...resolved,
          declaration: {
            ...resolved.declaration,
            agentSources: { agentsRoot: tmpdir(), provenance: 'caller-agent-root' },
          },
        }
      },
    })
    await withMobileSessionServer(
      async ({ post }) => {
        const response = await post()
        expect(response.status).toBe(500)
        expect(starts).toHaveLength(0)
      },
      client,
      { agentsRoot: TEST_AGENT_ROOT }
    )
  })

  test('U-7a: a substituted intent agentRoot fails closed', async () => {
    const { client, starts } = createMobileSessionHrcClient({
      resolveImpl: (request) => {
        const resolved = defaultDeclarationResolution(request)
        return { ...resolved, intent: { ...resolved.intent, placement: { agentRoot: tmpdir() } } }
      },
    })
    await withMobileSessionServer(async ({ post }) => {
      const response = await post()
      expect(response.status).toBe(500)
      expect(starts).toHaveLength(0)
    }, client)
  })

  test('U-7b: a textually different but identical echo passes', async () => {
    const linkDir = mkdtempSync(join(tmpdir(), 't08572-echo-'))
    symlinkSync(TEST_AGENT_ROOT, join(linkDir, 'agent-link'))
    const { client, starts } = createMobileSessionHrcClient({
      resolveImpl: (request) => {
        const resolved = defaultDeclarationResolution(request)
        return {
          ...resolved,
          declaration: {
            ...resolved.declaration,
            agentSources: { agentsRoot: `${TEST_AGENT_ROOT}/`, provenance: 'caller-agent-root' },
          },
          intent: {
            ...resolved.intent,
            placement: { agentRoot: join(linkDir, 'agent-link') },
          },
        }
      },
    })
    await withMobileSessionServer(
      async ({ post }) => {
        const response = await post()
        expect(response.status).toBe(200)
        expect(starts).toHaveLength(1)
      },
      client,
      { agentsRoot: TEST_AGENT_ROOT }
    )
  })

  test('U-10: start failures never carry the declaration label', async () => {
    for (const startError of [
      new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'aspd down', {
        code: 'aspd_unavailable',
      }),
      new Error('transport exploded'),
    ] as const) {
      const { client, starts } = createMobileSessionHrcClient({ startError })
      await withMobileSessionServer(async ({ post, json }) => {
        const response = await post()
        expect(starts).toHaveLength(1)
        const body = await json<{ error: { code: string; details?: Record<string, unknown> } }>(
          response
        )
        expect(body.error.details ?? {}).not.toHaveProperty('stage')
        expect(body.error.details ?? {}).not.toHaveProperty('attemptState')
        if (startError instanceof HrcDomainError) {
          expect(response.status).toBe(503)
          expect(body.error.code).toBe('runtime_unavailable')
        } else {
          expect(response.status).toBe(500)
          expect(body.error.code).toBe('internal_error')
        }
      }, client)
    }
  })
})
