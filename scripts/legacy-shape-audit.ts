#!/usr/bin/env bun

import { homedir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import {
  type InterfaceBinding,
  parseDurationToMs,
  resolveBinding,
  validateJobTrigger,
} from 'acp-core'
import {
  buildScopeRef,
  normalizeLaneRef,
  normalizeSessionRef,
  parseScopeRef,
  validateScopeRef,
} from 'agent-scope'

type Verdict = 'PASS' | 'FAIL'
type CheckStatus = Verdict | 'SKIP'

type AuditCheck = {
  name:
    | 'scope_ref parse'
    | 'lane_ref parse'
    | 'session_ref canonical'
    | 'trigger_json parse'
    | 'trigger validation'
    | 'cooldown parse'
    | 'binding routing'
  status: CheckStatus
  detail?: string | undefined
  error?: string | undefined
}

type AuditRow = {
  table: 'jobs' | 'interface_bindings'
  id: string
  slugOrLookup: string
  agent: string
  project: string
  kind: string
  verdict: Verdict
  failures: Array<{ check: AuditCheck['name']; error: string }>
  checks: AuditCheck[]
}

type JobRow = {
  job_id: string
  slug: string | null
  project_id: string
  agent_id: string
  scope_ref: string
  lane_ref: string
  trigger_kind: string
  trigger_json: string
}

type InterfaceBindingRow = {
  binding_id: string
  gateway_id: string
  gateway_type: string
  conversation_ref: string
  thread_ref: string | null
  lane_ref: string
  project_id: string
  agent_id: string
  task_id: string | null
  role_name: string | null
  status: 'active' | 'disabled'
  created_at: string
  updated_at: string
}

export type LegacyShapeAuditOptions = {
  jobsDbPath?: string | undefined
  interfaceDbPath?: string | undefined
}

export type LegacyShapeAuditReport = {
  generatedAt: string
  readOnly: true
  databases: {
    jobs: string
    interface: string
  }
  parserExports: Array<{
    module: string
    exportName: string
    purpose: string
  }>
  summary: {
    verdict: Verdict
    jobs: { total: number; pass: number; fail: number }
    interfaceBindings: { total: number; pass: number; fail: number }
  }
  jobs: AuditRow[]
  interfaceBindings: AuditRow[]
}

const DEFAULT_JOBS_DB = join(homedir(), 'praesidium/var/db/acp-jobs.db')
const DEFAULT_INTERFACE_DB = join(homedir(), 'praesidium/var/db/acp-interface.db')

const PARSER_EXPORTS = [
  {
    module: 'acp-core',
    exportName: 'validateJobTrigger',
    purpose: 'Validate stored jobs.trigger_json shape and discriminant.',
  },
  {
    module: 'acp-core',
    exportName: 'parseDurationToMs',
    purpose: 'Parse stored event trigger cooldown strings.',
  },
  {
    module: 'acp-core',
    exportName: 'resolveBinding',
    purpose: 'Validate active interface binding lookup/routing semantics.',
  },
  {
    module: 'agent-scope',
    exportName: 'normalizeSessionRef',
    purpose:
      'Canonicalize stored scope_ref/lane_ref; this is the utility ACP-core uses internally.',
  },
  {
    module: 'agent-scope',
    exportName: 'validateScopeRef',
    purpose: 'Distinguish scope_ref parse failures from lane_ref parse failures.',
  },
  {
    module: 'agent-scope',
    exportName: 'normalizeLaneRef',
    purpose: 'Distinguish lane_ref parse failures from scope_ref parse failures.',
  },
] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pass(name: AuditCheck['name'], detail?: string): AuditCheck {
  return { name, status: 'PASS', ...(detail !== undefined ? { detail } : {}) }
}

function skip(name: AuditCheck['name'], detail: string): AuditCheck {
  return { name, status: 'SKIP', detail }
}

function fail(name: AuditCheck['name'], error: string): AuditCheck {
  return { name, status: 'FAIL', error }
}

function finalizeRow(row: Omit<AuditRow, 'verdict' | 'failures'>): AuditRow {
  const failures = row.checks
    .filter((check) => check.status === 'FAIL')
    .map((check) => ({
      check: check.name,
      error: check.error ?? 'unknown parser error',
    }))
  return {
    ...row,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
  }
}

function openReadOnlyDatabase(path: string): Database {
  const database = new Database(path, { readonly: true })
  database.exec('PRAGMA query_only = ON;')
  return database
}

function queryRows<T>(database: Database, sql: string): T[] {
  return database.query(sql).all() as T[]
}

function parseJson(value: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function sessionChecks(scopeRef: string, laneRef: string): AuditCheck[] {
  const checks: AuditCheck[] = []

  const scopeValidation = validateScopeRef(scopeRef)
  if (!scopeValidation.ok) {
    checks.push(fail('scope_ref parse', scopeValidation.error))
  } else {
    try {
      parseScopeRef(scopeRef)
      checks.push(pass('scope_ref parse'))
    } catch (error) {
      checks.push(fail('scope_ref parse', errorMessage(error)))
    }
  }

  let canonicalLaneRef: string | undefined
  try {
    canonicalLaneRef = normalizeLaneRef(laneRef)
    checks.push(pass('lane_ref parse', `canonical=${canonicalLaneRef}`))
  } catch (error) {
    checks.push(fail('lane_ref parse', errorMessage(error)))
  }

  if (checks.some((check) => check.status === 'FAIL')) {
    checks.push(skip('session_ref canonical', 'scope_ref or lane_ref parse failed'))
    return checks
  }

  try {
    const normalized = normalizeSessionRef({ scopeRef, laneRef })
    if (normalized.scopeRef !== scopeRef || normalized.laneRef !== laneRef) {
      checks.push(
        fail(
          'session_ref canonical',
          `stored session ref is non-canonical: normalized scope_ref=${normalized.scopeRef} lane_ref=${normalized.laneRef}`
        )
      )
    } else {
      checks.push(pass('session_ref canonical'))
    }
  } catch (error) {
    checks.push(fail('session_ref canonical', errorMessage(error)))
  }

  return checks
}

function auditJob(row: JobRow): AuditRow {
  const checks = sessionChecks(row.scope_ref, row.lane_ref)

  const parsedTrigger = parseJson(row.trigger_json)
  if (!parsedTrigger.ok) {
    checks.push(fail('trigger_json parse', parsedTrigger.error))
    checks.push(skip('trigger validation', 'trigger_json parse failed'))
    checks.push(skip('cooldown parse', 'trigger_json parse failed'))
  } else {
    checks.push(pass('trigger_json parse'))
    const triggerValidation = validateJobTrigger(parsedTrigger.value)
    if (!triggerValidation.valid) {
      checks.push(fail('trigger validation', triggerValidation.errors.join('; ')))
    } else {
      checks.push(pass('trigger validation'))
    }

    if (
      parsedTrigger.value !== null &&
      typeof parsedTrigger.value === 'object' &&
      !Array.isArray(parsedTrigger.value) &&
      (parsedTrigger.value as Record<string, unknown>)['kind'] === 'event'
    ) {
      const cooldown = (parsedTrigger.value as Record<string, unknown>)['cooldown']
      if (cooldown === undefined) {
        checks.push(skip('cooldown parse', 'event trigger has no cooldown'))
      } else if (typeof cooldown !== 'string') {
        checks.push(fail('cooldown parse', 'trigger.cooldown must be a string'))
      } else {
        const parsedMs = parseDurationToMs(cooldown)
        if (parsedMs === undefined) {
          checks.push(fail('cooldown parse', `unparseable cooldown: ${cooldown}`))
        } else {
          checks.push(pass('cooldown parse', `${parsedMs}ms`))
        }
      }
    } else {
      checks.push(skip('cooldown parse', 'not an event trigger'))
    }
  }

  return finalizeRow({
    table: 'jobs',
    id: row.job_id,
    slugOrLookup: row.slug ?? row.job_id,
    agent: row.agent_id,
    project: row.project_id,
    kind: row.trigger_kind,
    checks,
  })
}

function optionalString(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value
}

function bindingScopeRef(row: InterfaceBindingRow): string {
  return buildScopeRef({
    agentId: row.agent_id,
    projectId: row.project_id,
    ...(optionalString(row.task_id) !== undefined ? { taskId: optionalString(row.task_id) } : {}),
    ...(optionalString(row.role_name) !== undefined
      ? { roleName: optionalString(row.role_name) }
      : {}),
  })
}

function toCoreBinding(row: InterfaceBindingRow): InterfaceBinding {
  return {
    bindingId: row.binding_id,
    gatewayId: row.gateway_id,
    gatewayType: row.gateway_type,
    conversationRef: row.conversation_ref,
    ...(optionalString(row.thread_ref) !== undefined
      ? { threadRef: optionalString(row.thread_ref) }
      : {}),
    sessionRef: {
      scopeRef: bindingScopeRef(row),
      laneRef: row.lane_ref,
    },
    projectId: row.project_id,
    agentId: row.agent_id,
    ...(optionalString(row.task_id) !== undefined ? { taskId: optionalString(row.task_id) } : {}),
    ...(optionalString(row.role_name) !== undefined
      ? { roleName: optionalString(row.role_name) }
      : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function bindingLookup(row: InterfaceBindingRow): string {
  const threadRef = optionalString(row.thread_ref)
  return threadRef === undefined
    ? `${row.gateway_id}/${row.conversation_ref}`
    : `${row.gateway_id}/${row.conversation_ref}/${threadRef}`
}

function auditBinding(row: InterfaceBindingRow, allBindings: InterfaceBinding[]): AuditRow {
  const scopeRef = bindingScopeRef(row)
  const checks = sessionChecks(scopeRef, row.lane_ref)

  const threadRef = optionalString(row.thread_ref)
  if (row.status === 'disabled') {
    checks.push(skip('binding routing', 'disabled binding is intentionally not routable'))
  } else {
    const resolved = resolveBinding(allBindings, {
      gatewayId: row.gateway_id,
      conversationRef: row.conversation_ref,
      ...(threadRef !== undefined ? { threadRef } : {}),
    })
    if (resolved?.bindingId === row.binding_id) {
      checks.push(pass('binding routing'))
    } else if (resolved === null) {
      checks.push(fail('binding routing', 'active binding lookup resolved no binding'))
    } else {
      checks.push(
        fail(
          'binding routing',
          `active binding lookup resolved ${resolved.bindingId} instead of ${row.binding_id}`
        )
      )
    }
  }

  return finalizeRow({
    table: 'interface_bindings',
    id: row.binding_id,
    slugOrLookup: bindingLookup(row),
    agent: row.agent_id,
    project: row.project_id,
    kind: row.gateway_type,
    checks,
  })
}

function summarize(rows: AuditRow[]): { total: number; pass: number; fail: number } {
  const failCount = rows.filter((row) => row.verdict === 'FAIL').length
  return {
    total: rows.length,
    pass: rows.length - failCount,
    fail: failCount,
  }
}

export function runLegacyShapeAudit(options: LegacyShapeAuditOptions = {}): LegacyShapeAuditReport {
  const jobsDbPath = options.jobsDbPath ?? process.env['ACP_JOBS_DB'] ?? DEFAULT_JOBS_DB
  const interfaceDbPath =
    options.interfaceDbPath ?? process.env['ACP_INTERFACE_DB'] ?? DEFAULT_INTERFACE_DB

  const jobsDb = openReadOnlyDatabase(jobsDbPath)
  const interfaceDb = openReadOnlyDatabase(interfaceDbPath)
  try {
    const jobRows = queryRows<JobRow>(
      jobsDb,
      `SELECT job_id,
              slug,
              project_id,
              agent_id,
              scope_ref,
              lane_ref,
              trigger_kind,
              trigger_json
         FROM jobs
        WHERE archived_at IS NULL
        ORDER BY project_id, slug, job_id`
    )
    const bindingRows = queryRows<InterfaceBindingRow>(
      interfaceDb,
      `SELECT binding_id,
              gateway_id,
              gateway_type,
              conversation_ref,
              thread_ref,
              lane_ref,
              project_id,
              agent_id,
              task_id,
              role_name,
              status,
              created_at,
              updated_at
         FROM interface_bindings
        ORDER BY gateway_id, conversation_ref, COALESCE(thread_ref, ''), binding_id`
    )

    const allBindings = bindingRows.map(toCoreBinding)
    const jobs = jobRows.map(auditJob)
    const interfaceBindings = bindingRows.map((row) => auditBinding(row, allBindings))
    const jobsSummary = summarize(jobs)
    const interfaceSummary = summarize(interfaceBindings)
    const verdict = jobsSummary.fail === 0 && interfaceSummary.fail === 0 ? 'PASS' : 'FAIL'

    return {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      databases: {
        jobs: jobsDbPath,
        interface: interfaceDbPath,
      },
      parserExports: [...PARSER_EXPORTS],
      summary: {
        verdict,
        jobs: jobsSummary,
        interfaceBindings: interfaceSummary,
      },
      jobs,
      interfaceBindings,
    }
  } finally {
    jobsDb.close()
    interfaceDb.close()
  }
}

function renderCheck(check: AuditCheck): string {
  if (check.status === 'FAIL') {
    return `    - ${check.name}: FAIL - ${check.error ?? 'unknown parser error'}`
  }
  if (check.status === 'SKIP') {
    return `    - ${check.name}: SKIP - ${check.detail ?? ''}`
  }
  return check.detail === undefined
    ? `    - ${check.name}: PASS`
    : `    - ${check.name}: PASS - ${check.detail}`
}

function renderRows(title: string, rows: AuditRow[]): string[] {
  const lines = [`${title}:`]
  for (const row of rows) {
    const marker = row.verdict === 'FAIL' ? 'FAIL' : 'PASS'
    lines.push(
      `  [${marker}] ${row.table} id=${row.id} slug/lookup=${row.slugOrLookup} agent=${row.agent} project=${row.project} kind=${row.kind}`
    )
    for (const check of row.checks) {
      lines.push(renderCheck(check))
    }
  }
  return lines
}

export function renderHumanReport(report: LegacyShapeAuditReport): string {
  const lines = [
    'ACP legacy-shape audit',
    `generated_at: ${report.generatedAt}`,
    `read_only: ${String(report.readOnly)}`,
    `jobs_db: ${report.databases.jobs}`,
    `interface_db: ${report.databases.interface}`,
    '',
    'parser_exports:',
    ...report.parserExports.map(
      (parser) => `  - ${parser.module}.${parser.exportName}: ${parser.purpose}`
    ),
    '',
    `summary: ${report.summary.verdict}`,
    `  jobs: total=${report.summary.jobs.total} pass=${report.summary.jobs.pass} fail=${report.summary.jobs.fail}`,
    `  interface_bindings: total=${report.summary.interfaceBindings.total} pass=${report.summary.interfaceBindings.pass} fail=${report.summary.interfaceBindings.fail}`,
    '',
    ...renderRows('jobs', report.jobs),
    '',
    ...renderRows('interface_bindings', report.interfaceBindings),
  ]

  return lines.join('\n')
}

if (import.meta.main) {
  const failOnFailures = process.argv.includes('--fail-on-failures')
  const report = runLegacyShapeAudit()
  console.log(renderHumanReport(report))
  console.log('')
  console.log('JSON report:')
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = failOnFailures && report.summary.verdict === 'FAIL' ? 1 : 0
}
