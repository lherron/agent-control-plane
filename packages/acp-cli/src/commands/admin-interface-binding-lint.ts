import type { InterfaceBinding } from 'acp-core'
import { parseScopeRef, validateScopeRef } from 'agent-scope'

import { hasFlag, parseArgs, requireNoPositionals, requireStringFlag } from './options.js'

import { createAdminClient } from './admin-interface-binding-shared.js'
import { type CommandDependencies, type CommandOutput, asJson, asText } from './shared.js'

export type BindingLintIssueCode =
  | 'missing_project_in_scope'
  | 'missing_project_id'
  | 'project_mismatch'
  | 'invalid_scope_ref'

export type BindingLintIssue = {
  code: BindingLintIssueCode
  message: string
}

export type BindingLintEntry = {
  bindingId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  status: InterfaceBinding['status']
  scopeRef: string
  laneRef: string
  projectId?: string | undefined
  issues: BindingLintIssue[]
}

export type BindingLintReport = {
  total: number
  active: number
  issueCount: number
  bindings: BindingLintEntry[]
}

export function lintBinding(binding: InterfaceBinding): BindingLintEntry {
  const issues: BindingLintIssue[] = []
  const scopeRef = binding.sessionRef.scopeRef

  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) {
    issues.push({
      code: 'invalid_scope_ref',
      message: `scopeRef does not parse: ${validation.error}`,
    })
  } else {
    const parsed = parseScopeRef(scopeRef)
    if (parsed.projectId === undefined) {
      issues.push({
        code: 'missing_project_in_scope',
        message: `scopeRef "${scopeRef}" has no project segment; expected agent:<id>:project:<id>`,
      })
    }

    if (binding.projectId === undefined) {
      issues.push({
        code: 'missing_project_id',
        message: 'binding has no projectId field set',
      })
    } else if (parsed.projectId !== undefined && parsed.projectId !== binding.projectId) {
      issues.push({
        code: 'project_mismatch',
        message: `binding.projectId="${binding.projectId}" disagrees with scopeRef project "${parsed.projectId}"`,
      })
    }
  }

  return {
    bindingId: binding.bindingId,
    gatewayId: binding.gatewayId,
    conversationRef: binding.conversationRef,
    ...(binding.threadRef !== undefined ? { threadRef: binding.threadRef } : {}),
    status: binding.status,
    scopeRef,
    laneRef: binding.sessionRef.laneRef,
    ...(binding.projectId !== undefined ? { projectId: binding.projectId } : {}),
    issues,
  }
}

export function buildBindingLintReport(
  bindings: readonly InterfaceBinding[],
  options: { includeDisabled: boolean }
): BindingLintReport {
  const scoped = options.includeDisabled ? bindings : bindings.filter((b) => b.status === 'active')
  const entries = scoped.map(lintBinding)
  const issueCount = entries.reduce((acc, entry) => acc + entry.issues.length, 0)

  return {
    total: bindings.length,
    active: bindings.filter((b) => b.status === 'active').length,
    issueCount,
    bindings: entries,
  }
}

function renderLintReport(report: BindingLintReport, options: { onlyIssues: boolean }): string {
  const header =
    `Scanned ${report.total} binding(s), ${report.active} active. ` +
    `Found ${report.issueCount} issue(s).`

  const rendered = report.bindings
    .filter((entry) => !options.onlyIssues || entry.issues.length > 0)
    .map((entry) => {
      const lines = [
        `${entry.bindingId} ${entry.status}${entry.issues.length === 0 ? ' OK' : ''}`,
        `  gateway: ${entry.gatewayId}`,
        `  conversation: ${entry.conversationRef}`,
        `  scope: ${entry.scopeRef} (${entry.laneRef})`,
        `  project: ${entry.projectId ?? '(none)'}`,
      ]
      for (const issue of entry.issues) {
        lines.push(`  ! ${issue.code}: ${issue.message}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')

  if (rendered.length === 0) {
    return `${header}\n(no problem bindings)`
  }

  return `${header}\n\n${rendered}`
}

export async function runAdminInterfaceBindingLintCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--all', '--show-ok'],
    stringFlags: ['--gateway', '--project', '--server', '--actor'],
  })
  requireNoPositionals(parsed)

  const client = createAdminClient(parsed, deps)
  const response = await client.listInterfaceBindings({
    ...(parsed.stringFlags['--gateway'] !== undefined
      ? { gatewayId: requireStringFlag(parsed, '--gateway') }
      : {}),
    ...(parsed.stringFlags['--project'] !== undefined
      ? { projectId: requireStringFlag(parsed, '--project') }
      : {}),
  })

  const report = buildBindingLintReport(response.bindings, {
    includeDisabled: hasFlag(parsed, '--all'),
  })

  return hasFlag(parsed, '--json')
    ? asJson(report)
    : asText(renderLintReport(report, { onlyIssues: !hasFlag(parsed, '--show-ok') }))
}
