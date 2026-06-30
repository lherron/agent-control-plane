import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { main } from '../cli.js'

// Fixture is at tests/fixtures/resources/asp-plan-v1.json relative to repo root.
// From __tests__/ → src/ → acp-cli/ → packages/ → repo root  (4 levels up)
const PLAN_FIXTURE_PATH = resolve(
  import.meta.dirname,
  '../../../../tests/fixtures/resources/asp-plan-v1.json'
)

// The fixture has 3 resources; used to verify outcomes array length.
const PLAN_RESOURCE_COUNT = 3
const PLAN_OWNER_SCOPE_REF = 'agent:smokey:project:agent-spaces'

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type FetchExpectation = {
  status?: number | undefined
  body?: unknown
  assert(request: { url: string; method: string; headers: Headers; body: unknown }): void
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, target: string[]): void {
  if (typeof chunk === 'string') {
    target.push(chunk)
    return
  }
  const view = chunk as ArrayBufferView
  target.push(Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8'))
}

async function runCli(
  args: string[],
  options: {
    fetchImpl?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
    env?: NodeJS.ProcessEnv | undefined
  } = {}
): Promise<CliResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit

  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stdout)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stderr)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write

  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  try {
    await main(args, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: 0 }
  } catch (error) {
    if (error instanceof CliExit) {
      return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: error.code }
    }
    throw error
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
  }
}

function createFetchQueue(expectations: FetchExpectation[]) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []

  return {
    calls,
    async fetchImpl(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const text = await request.text()
      const body =
        text.length === 0
          ? undefined
          : (() => {
              try {
                return JSON.parse(text) as unknown
              } catch {
                return text
              }
            })()

      const recorded = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      }
      calls.push(recorded)

      const expectation = expectations.shift()
      if (expectation === undefined) {
        throw new Error(`unexpected fetch for ${request.method} ${request.url}`)
      }

      expectation.assert(recorded)
      return new Response(
        expectation.body === undefined ? null : JSON.stringify(expectation.body),
        {
          status: expectation.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    },
  }
}

describe('acp admin managed-resource apply', () => {
  test('--json output contains outcomes array (one per resource) and stats object', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          outcomes: [
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:scheduled-job:daily-triage',
              resourceKind: 'scheduled-job',
              projectionPk: 'agent-smokey.daily-triage',
              outcome: 'created',
            },
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:interface-binding:discord-smoke',
              resourceKind: 'interface-binding',
              projectionPk: 'agent-smokey.discord-smoke',
              outcome: 'created',
            },
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:event-hook:wrkq-needs-smoketest',
              resourceKind: 'event-hook',
              projectionPk: 'agent-smokey.wrkq-needs-smoketest',
              outcome: 'created',
            },
          ],
          stats: { created: 3, updated: 0, noop: 0, failed: 0 },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/managed-resources/apply')
          const body = request.body as { plan: { resources: unknown[] } }
          expect(body).toHaveProperty('plan')
          expect(Array.isArray(body.plan.resources)).toBe(true)
          expect(body.plan.resources).toHaveLength(PLAN_RESOURCE_COUNT)
        },
      },
    ])

    const result = await runCli(
      ['admin', 'managed-resource', 'apply', '--in', PLAN_FIXTURE_PATH, '--json'],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      outcomes: Array<{
        projectionId: string
        resourceKind: string
        projectionPk: string
        outcome: string
      }>
      stats: { created: number; updated: number; noop: number; failed: number }
    }
    expect(Array.isArray(parsed.outcomes)).toBe(true)
    expect(parsed.outcomes).toHaveLength(PLAN_RESOURCE_COUNT)
    expect(parsed.stats).toMatchObject({ created: 3, updated: 0, noop: 0, failed: 0 })
    expect(fetchQueue.calls).toHaveLength(1)
  })

  test('text output shows live id, next fire, disabled, drift, and fresh-flow summary', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          outcomes: [
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:scheduled-job:daily-triage',
              resourceKind: 'scheduled-job',
              projectionPk: 'agent-smokey.daily-triage',
              outcome: 'created',
              jobId: 'job_123',
              liveSlug: 'agent-smokey.daily-triage',
              nextFireAt: '2026-06-18T13:00:00.000Z',
              disabled: false,
              hasDrift: false,
              flowSummary: {
                enabled: true,
                stepCount: 1,
                freshStepCount: 1,
                freshDurationStepCount: 0,
              },
            },
          ],
          stats: { created: 1, updated: 0, noop: 0, failed: 0 },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/managed-resources/apply')
        },
      },
    ])

    const result = await runCli(['admin', 'managed-resource', 'apply', '--in', PLAN_FIXTURE_PATH], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('job_123')
    expect(result.stdout).toContain('2026-06-18T13:00:00.000Z')
    expect(result.stdout).toContain('false')
    expect(result.stdout).toContain('no')
    expect(result.stdout).toMatch(/flow|1.*fresh|fresh.*1/)
  })
})

describe('acp admin managed-resource status', () => {
  test('--json output contains resources array for owner scope', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          resources: [
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:scheduled-job:daily-triage',
              resourceKind: 'scheduled-job',
              projectionPk: 'agent-smokey.daily-triage',
              state: 'active',
              hasDrift: false,
            },
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:interface-binding:discord-smoke',
              resourceKind: 'interface-binding',
              projectionPk: 'agent-smokey.discord-smoke',
              state: 'active',
              hasDrift: false,
            },
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:event-hook:wrkq-needs-smoketest',
              resourceKind: 'event-hook',
              projectionPk: 'agent-smokey.wrkq-needs-smoketest',
              state: 'active',
              hasDrift: false,
            },
          ],
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/managed-resources/status')
          // T-05244: status is now plan-aware — the CLI sends the plan so the
          // server can classify stale (missing-source) resources.
          const body = request.body as { plan?: { sourceOwnerScopeRef?: string } }
          expect(body.plan).toBeDefined()
          expect(body.plan).toHaveProperty('sourceOwnerScopeRef', PLAN_OWNER_SCOPE_REF)
        },
      },
    ])

    const result = await runCli(
      ['admin', 'managed-resource', 'status', '--in', PLAN_FIXTURE_PATH, '--json'],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      resources: Array<{
        projectionId: string
        resourceKind: string
        projectionPk: string
        state: string
        hasDrift: boolean
      }>
    }
    expect(Array.isArray(parsed.resources)).toBe(true)
    expect(parsed.resources).toHaveLength(PLAN_RESOURCE_COUNT)
    expect(fetchQueue.calls).toHaveLength(1)
  })

  test('text output shows live id, next fire, disabled, drift, and binding target identity', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          resources: [
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:scheduled-job:daily-triage',
              resourceKind: 'scheduled-job',
              projectionPk: 'agent-smokey.daily-triage',
              state: 'active',
              hasDrift: false,
              jobId: 'job_123',
              liveSlug: 'agent-smokey.daily-triage',
              nextFireAt: '2026-06-18T13:00:00.000Z',
              disabled: false,
              flowSummary: {
                enabled: true,
                stepCount: 1,
                freshStepCount: 1,
                freshDurationStepCount: 0,
              },
            },
            {
              projectionId:
                'agent-directory:agent:smokey:project:agent-spaces:interface-binding:discord-smoke',
              resourceKind: 'interface-binding',
              projectionPk: 'agent-smokey.discord-smoke',
              state: 'active',
              hasDrift: false,
              bindingId: 'agent-smokey.discord-smoke',
              disabled: false,
              bindingTarget: {
                gatewayId: 'acp-discord-smoke',
                conversationRef: 'channel:1501224513390772224',
                threadRef: 'thread:1501224513390772225',
                scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
                laneRef: 'main',
              },
            },
          ],
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/managed-resources/status')
        },
      },
    ])

    const result = await runCli(
      ['admin', 'managed-resource', 'status', '--in', PLAN_FIXTURE_PATH],
      {
        fetchImpl: fetchQueue.fetchImpl,
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('job_123')
    expect(result.stdout).toContain('agent-smokey.discord-smoke')
    expect(result.stdout).toContain('2026-06-18T13:00:00.000Z')
    expect(result.stdout).toContain('false')
    expect(result.stdout).toContain('no')
    expect(result.stdout).toMatch(/flow|1.*fresh|fresh.*1/)
  })
})
