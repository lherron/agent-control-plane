import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { fetchPlacementResolution } from '../src/placement-resolution.js'

let socketCounter = 0

async function withPlacementDaemon(
  handler: (body: unknown) => Response,
  run: (socketPath: string, seen: unknown[]) => Promise<void>
): Promise<void> {
  socketCounter += 1
  const socketPath = join(tmpdir(), `acp-placement-test-${process.pid}-${socketCounter}.sock`)
  const seen: unknown[] = []
  const server = Bun.serve({
    unix: socketPath,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== 'POST' || url.pathname !== '/v1/placements/resolve') {
        return new Response('not found', { status: 404 })
      }
      const body = await request.json()
      seen.push(body)
      return handler(body)
    },
  })
  try {
    await run(socketPath, seen)
  } finally {
    server.stop(true)
    await rm(socketPath, { force: true })
  }
}

const daemonPlacement = {
  agentRoot: '/agents/cody',
  projectRoot: '/projects/agent-spaces',
  cwd: '/projects/agent-spaces',
  bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: '/projects/agent-spaces' },
  bundleIdentity: 'deadbeef',
  harness: {
    provider: 'openai',
    frontend: 'codex-cli',
    effectiveHarness: 'codex',
    transport: 'cli',
    interactive: true,
  },
}

describe('daemon placement resolution transport', () => {
  test('maps the daemon resolution to placement fields', async () => {
    await withPlacementDaemon(
      () => Response.json(daemonPlacement),
      async (socketPath, seen) => {
        const resolved = await fetchPlacementResolution(
          { scopeRef: 'agent:cody:project:agent-spaces:task:discord', runMode: 'task' },
          { socketPath }
        )
        expect(resolved.agentRoot).toBe('/agents/cody')
        expect(resolved.projectRoot).toBe('/projects/agent-spaces')
        expect(resolved.cwd).toBe('/projects/agent-spaces')
        expect(resolved.bundle).toEqual({
          kind: 'agent-project',
          agentName: 'cody',
          projectRoot: '/projects/agent-spaces',
        })
        expect(resolved.bundleIdentity).toBe('deadbeef')
        expect(resolved.harness).toEqual({
          provider: 'openai',
          interactive: true,
          frontend: 'codex-cli',
          effectiveHarness: 'codex',
          transport: 'cli',
        })
        expect(seen).toEqual([
          { scopeRef: 'agent:cody:project:agent-spaces:task:discord', runMode: 'task' },
        ])
      }
    )
  })

  test('propagates the daemon declaration refusal with its code and message', async () => {
    await withPlacementDaemon(
      () =>
        Response.json(
          {
            error: {
              code: 'declaration_invalid',
              message: 'project root unknown for missing-project',
              detail: { source: 'project-targets' },
            },
          },
          { status: 422 }
        ),
      async (socketPath) => {
        const error = await fetchPlacementResolution(
          { scopeRef: 'agent:mable:project:missing-project:task:x' },
          { socketPath }
        ).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(HrcDomainError)
        expect((error as HrcDomainError).code).toBe(HrcErrorCode.DECLARATION_INVALID)
        expect((error as Error).message).toBe('project root unknown for missing-project')
      }
    )
  })

  test('reports an unreachable daemon as runtime_unavailable', async () => {
    const missing = join(tmpdir(), `acp-placement-missing-${process.pid}.sock`)
    const error = await fetchPlacementResolution(
      { scopeRef: 'agent:cody:project:agent-spaces' },
      { socketPath: missing }
    ).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(HrcDomainError)
    expect((error as HrcDomainError).code).toBe(HrcErrorCode.RUNTIME_UNAVAILABLE)
  })

  test('reports a daemon without the route as unsupported_capability', async () => {
    const socketPath = join(tmpdir(), `acp-placement-noroute-${process.pid}.sock`)
    const server = Bun.serve({
      unix: socketPath,
      fetch: () => new Response('nope', { status: 404 }),
    })
    try {
      const error = await fetchPlacementResolution(
        { scopeRef: 'agent:cody:project:agent-spaces' },
        { socketPath }
      ).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(HrcDomainError)
      expect((error as HrcDomainError).code).toBe(HrcErrorCode.UNSUPPORTED_CAPABILITY)
    } finally {
      server.stop(true)
      await rm(socketPath, { force: true })
    }
  })

  test('fails closed on a malformed resolution body', async () => {
    await withPlacementDaemon(
      () => Response.json({ agentRoot: '/agents/cody' }),
      async (socketPath) => {
        const error = await fetchPlacementResolution(
          { scopeRef: 'agent:cody:project:agent-spaces' },
          { socketPath }
        ).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(HrcDomainError)
        expect((error as HrcDomainError).code).toBe(HrcErrorCode.RUNTIME_UNAVAILABLE)
      }
    )
  })
})
