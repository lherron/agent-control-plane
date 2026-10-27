import { describe, expect, test } from 'bun:test'

import type { InterfaceBinding } from 'acp-core'

import { createFetchQueue, runCli } from '../cli-test-helpers.js'

function binding(overrides: Partial<InterfaceBinding> & { bindingId: string }): InterfaceBinding {
  return {
    bindingId: overrides.bindingId,
    gatewayId: overrides.gatewayId ?? 'acp-discord-smoke',
    conversationRef: overrides.conversationRef ?? 'channel:1',
    sessionRef: overrides.sessionRef ?? {
      scopeRef: 'agent:foo:project:bar',
      laneRef: 'main',
    },
    ...(overrides.threadRef !== undefined ? { threadRef: overrides.threadRef } : {}),
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? '2026-05-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-01T00:00:00.000Z',
  }
}

describe('admin interface-binding lint CLI', () => {
  test('reports each scope and project issue as JSON', async () => {
    const cases = [
      [binding({ bindingId: 'ok', projectId: 'bar' }), []],
      [
        binding({
          bindingId: 'bare',
          sessionRef: { scopeRef: 'agent:foo', laneRef: 'main' },
          projectId: 'bar',
        }),
        ['missing_project_in_scope'],
      ],
      [binding({ bindingId: 'missing' }), ['missing_project_id']],
      [binding({ bindingId: 'mismatch', projectId: 'baz' }), ['project_mismatch']],
      [
        binding({
          bindingId: 'invalid',
          sessionRef: { scopeRef: 'not-a-scope', laneRef: 'main' },
          projectId: 'bar',
        }),
        ['invalid_scope_ref'],
      ],
      [
        binding({
          bindingId: 'task',
          sessionRef: {
            scopeRef: 'agent:cody:project:agent-spaces:task:doc-sweeper',
            laneRef: 'main',
          },
          projectId: 'agent-spaces',
        }),
        [],
      ],
    ] as const
    for (const [item, codes] of cases) {
      const queue = createFetchQueue([
        {
          body: { bindings: [item] },
          assert(request) {
            expect(new URL(request.url).pathname).toBe('/v1/interface/bindings')
          },
        },
      ])
      const result = await runCli(['admin', 'interface', 'binding', 'lint', '--json'], {
        fetchImpl: queue.fetchImpl,
      })
      expect(result.exitCode).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.bindings[0].issues.map((issue: { code: string }) => issue.code)).toEqual(codes)
      expect(report.issueCount).toBe(codes.length)
    }
  })

  test('counts active bindings and includes disabled with --all', async () => {
    const bindings = [
      binding({
        bindingId: 'ok',
        sessionRef: { scopeRef: 'agent:a:project:p', laneRef: 'main' },
        projectId: 'p',
      }),
      binding({
        bindingId: 'bad',
        sessionRef: { scopeRef: 'agent:a', laneRef: 'main' },
        projectId: 'p',
      }),
      binding({
        bindingId: 'disabled-bad',
        sessionRef: { scopeRef: 'agent:a', laneRef: 'main' },
        projectId: 'p',
        status: 'disabled',
      }),
    ]
    for (const all of [false, true]) {
      const queue = createFetchQueue([{ body: { bindings }, assert() {} }])
      const result = await runCli(
        ['admin', 'interface', 'binding', 'lint', ...(all ? ['--all'] : []), '--json'],
        { fetchImpl: queue.fetchImpl }
      )
      expect(result.exitCode).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.total).toBe(3)
      expect(report.active).toBe(2)
      expect(report.bindings).toHaveLength(all ? 3 : 2)
      expect(report.issueCount).toBe(all ? 2 : 1)
      if (all)
        expect(report.bindings[2].issues.map((issue: { code: string }) => issue.code)).toContain(
          'missing_project_in_scope'
        )
    }
  })

  test('renders human-readable text by default', async () => {
    const queue = createFetchQueue([
      { body: { bindings: [binding({ bindingId: 'ok', projectId: 'bar' })] }, assert() {} },
    ])
    const result = await runCli(['admin', 'interface', 'binding', 'lint'], {
      fetchImpl: queue.fetchImpl,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Scanned 1 binding(s)')
    expect(result.stdout).toContain('Found 0 issue(s)')
  })
})
