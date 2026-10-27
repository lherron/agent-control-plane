import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { collectRouteSummaries } from './lib/live-discovery.ts'

const tmpRoots: string[] = []

function tmpRoot(): string {
  const root = join(tmpdir(), `acp-live-discovery-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tmpRoots.push(root)
  return root
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('live ACP discovery', () => {
  test('param route is reported with its family, handler and the handler file it imports from', async () => {
    const root = tmpRoot()
    writeText(
      join(root, 'packages/acp-server/src/handlers/workflow-tasks.ts'),
      'export function handleGetWorkflowTask(): Response { return new Response("ok") }\nexport function handleOther(): Response { return new Response("ok") }\n'
    )
    writeText(
      join(root, 'packages/acp-server/src/routing/param-routes.ts'),
      `import {
  handleGetWorkflowTask,
  handleOther,
} from '../handlers/workflow-tasks.js'
export function buildParamRoutes() {
  return [
    createParamRoute('GET', '/v1/tasks/:taskId', handleGetWorkflowTask),
    createParamRoute('POST', '/v1/other/:id', handleOther),
  ]
}
`
    )

    const routes = await collectRouteSummaries(root)

    expect(routes.find((route) => route.key === 'GET /v1/tasks/:taskId')).toMatchObject({
      family: 'tasks',
      handler: 'handleGetWorkflowTask',
      handlerSource: 'packages/acp-server/src/handlers/workflow-tasks.ts',
      source: 'packages/acp-server/src/routing/param-routes.ts',
    })
  })

  test('route added to or removed from exact-routes.ts shows up or drops out on the next read', async () => {
    const root = tmpRoot()
    const exactRoutesPath = join(root, 'packages/acp-server/src/routing/exact-routes.ts')
    writeText(
      join(root, 'packages/acp-server/src/handlers/probe.ts'),
      'export function handleProbe(): Response { return new Response("ok") }\n'
    )

    const routeSource = (extra = '') => `import { handleProbe } from '../handlers/probe.js'
export function exactRouteKey(method: string, pathname: string): string {
  return \`\${method} \${pathname}\`
}
export function buildExactRouteHandlers() {
  return {
    [exactRouteKey('GET', '/v1/probe')]: handleProbe,
${extra}  }
}
`

    writeText(exactRoutesPath, routeSource())
    expect((await collectRouteSummaries(root)).map((route) => route.key)).toContain('GET /v1/probe')
    expect((await collectRouteSummaries(root)).map((route) => route.key)).not.toContain(
      'GET /v1/probe-throwaway'
    )

    writeText(
      exactRoutesPath,
      routeSource("    [exactRouteKey('GET', '/v1/probe-throwaway')]: handleProbe,\n")
    )
    expect((await collectRouteSummaries(root)).map((route) => route.key)).toContain(
      'GET /v1/probe-throwaway'
    )

    writeText(exactRoutesPath, routeSource())
    expect((await collectRouteSummaries(root)).map((route) => route.key)).not.toContain(
      'GET /v1/probe-throwaway'
    )
  })
})
