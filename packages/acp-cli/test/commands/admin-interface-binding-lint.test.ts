import { describe, expect, test } from 'bun:test'

import type { InterfaceBinding } from 'acp-core'

import {
  buildBindingLintReport,
  lintBinding,
  runAdminInterfaceBindingLintCommand,
} from '../../src/commands/admin-interface-binding-lint.js'
import type { AcpClient } from '../../src/http-client.js'

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

function createClientDouble(overrides: Partial<AcpClient>): AcpClient {
  return {
    createTask: overrides.createTask ?? (() => Promise.reject(new Error('not implemented'))),
    promoteTask: overrides.promoteTask ?? (() => Promise.reject(new Error('not implemented'))),
    getTask: overrides.getTask ?? (() => Promise.reject(new Error('not implemented'))),
    addEvidence: overrides.addEvidence ?? (() => Promise.reject(new Error('not implemented'))),
    transitionTask:
      overrides.transitionTask ?? (() => Promise.reject(new Error('not implemented'))),
    listTransitions:
      overrides.listTransitions ?? (() => Promise.reject(new Error('not implemented'))),
    listInterfaceBindings:
      overrides.listInterfaceBindings ?? (() => Promise.reject(new Error('not implemented'))),
    upsertInterfaceBinding:
      overrides.upsertInterfaceBinding ?? (() => Promise.reject(new Error('not implemented'))),
  }
}

describe('lintBinding', () => {
  test('clean binding has no issues', () => {
    const entry = lintBinding(
      binding({
        bindingId: 'ifb_ok',
        sessionRef: { scopeRef: 'agent:foo:project:bar', laneRef: 'main' },
        projectId: 'bar',
      })
    )
    expect(entry.issues).toEqual([])
  })

  test('flags bare-agent scopeRef as missing_project_in_scope', () => {
    const entry = lintBinding(
      binding({
        bindingId: 'ifb_bare',
        sessionRef: { scopeRef: 'agent:foo', laneRef: 'main' },
        projectId: 'bar',
      })
    )
    expect(entry.issues.map((i) => i.code)).toContain('missing_project_in_scope')
  })

  test('flags missing projectId field', () => {
    const entry = lintBinding(
      binding({
        bindingId: 'ifb_noproj',
        sessionRef: { scopeRef: 'agent:foo:project:bar', laneRef: 'main' },
      })
    )
    expect(entry.issues.map((i) => i.code)).toContain('missing_project_id')
  })

  test('flags scope/project mismatch', () => {
    const entry = lintBinding(
      binding({
        bindingId: 'ifb_mismatch',
        sessionRef: { scopeRef: 'agent:foo:project:bar', laneRef: 'main' },
        projectId: 'baz',
      })
    )
    expect(entry.issues.map((i) => i.code)).toContain('project_mismatch')
  })

  test('flags unparseable scopeRef', () => {
    const entry = lintBinding(
      binding({
        bindingId: 'ifb_bad',
        sessionRef: { scopeRef: 'not-a-scope', laneRef: 'main' },
        projectId: 'bar',
      })
    )
    expect(entry.issues.map((i) => i.code)).toContain('invalid_scope_ref')
  })

  test('task-scoped binding with matching project is clean', () => {
    const entry = lintBinding(
      binding({
        bindingId: 'ifb_task',
        sessionRef: {
          scopeRef: 'agent:cody:project:agent-spaces:task:doc-sweeper',
          laneRef: 'main',
        },
        projectId: 'agent-spaces',
      })
    )
    expect(entry.issues).toEqual([])
  })
})

describe('buildBindingLintReport', () => {
  test('counts active vs total and aggregates issues', () => {
    const report = buildBindingLintReport(
      [
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
      ],
      { includeDisabled: false }
    )

    expect(report.total).toBe(3)
    expect(report.active).toBe(2)
    expect(report.bindings).toHaveLength(2)
    expect(report.issueCount).toBe(1)
  })

  test('includeDisabled covers disabled bindings', () => {
    const report = buildBindingLintReport(
      [
        binding({
          bindingId: 'disabled-bad',
          sessionRef: { scopeRef: 'agent:a', laneRef: 'main' },
          status: 'disabled',
        }),
      ],
      { includeDisabled: true }
    )

    expect(report.bindings).toHaveLength(1)
    expect(report.issueCount).toBeGreaterThan(0)
  })
})

describe('runAdminInterfaceBindingLintCommand', () => {
  test('emits JSON report with --json', async () => {
    const client = createClientDouble({
      async listInterfaceBindings() {
        return {
          bindings: [
            binding({
              bindingId: 'ifb_bare',
              sessionRef: { scopeRef: 'agent:foo', laneRef: 'main' },
              projectId: 'bar',
            }),
          ],
        }
      },
    })

    const output = await runAdminInterfaceBindingLintCommand(['--json'], {
      createClient: () => client,
    })

    expect(output.format).toBe('json')
    if (output.format === 'json') {
      const body = output.body as {
        issueCount: number
        bindings: Array<{ issues: Array<{ code: string }> }>
      }
      expect(body.issueCount).toBeGreaterThan(0)
      expect(body.bindings[0]?.issues.map((i) => i.code)).toContain('missing_project_in_scope')
    }
  })

  test('renders human-readable text by default', async () => {
    const client = createClientDouble({
      async listInterfaceBindings() {
        return {
          bindings: [
            binding({
              bindingId: 'ifb_ok',
              sessionRef: { scopeRef: 'agent:foo:project:bar', laneRef: 'main' },
              projectId: 'bar',
            }),
          ],
        }
      },
    })

    const output = await runAdminInterfaceBindingLintCommand([], { createClient: () => client })
    expect(output.format).toBe('text')
    if (output.format === 'text') {
      expect(output.text).toContain('Scanned 1 binding(s)')
      expect(output.text).toContain('Found 0 issue(s)')
    }
  })
})
