import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { renderHumanReport, runLegacyShapeAudit } from './legacy-shape-audit.js'

const tmpRoots: string[] = []

function tmpRoot(): string {
  const root = join(tmpdir(), `acp-legacy-shape-audit-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tmpRoots.push(root)
  return root
}

function createJobsDb(path: string): void {
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        slug TEXT,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        archived_at TEXT
      );
    `)
    db.query(
      `INSERT INTO jobs (
         job_id, slug, project_id, agent_id, scope_ref, lane_ref, trigger_kind, trigger_json, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'job-pass',
      'passing-job',
      'agent-control-plane',
      'larry',
      'agent:larry:project:agent-control-plane:task:T-1',
      'main',
      'event',
      JSON.stringify({ kind: 'event', source: 'wrkq', match: {}, cooldown: '5m' }),
      null
    )
    db.query(
      `INSERT INTO jobs (
         job_id, slug, project_id, agent_id, scope_ref, lane_ref, trigger_kind, trigger_json, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'job-fail',
      'legacy-cooldown',
      'agent-control-plane',
      'larry',
      'agent:larry:project:agent-control-plane:task:T-2',
      'main',
      'event',
      JSON.stringify({ kind: 'event', source: 'wrkq', match: {}, cooldown: 'PT30S' }),
      null
    )
    db.query(
      `INSERT INTO jobs (
         job_id, slug, project_id, agent_id, scope_ref, lane_ref, trigger_kind, trigger_json, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'job-archived',
      'archived-job',
      'agent-control-plane',
      'larry',
      'agent:larry:project:agent-control-plane:task:T-3',
      'main',
      'schedule',
      JSON.stringify({ kind: 'schedule', cron: '* * * * *' }),
      '2026-06-18T00:00:00.000Z'
    )
  } finally {
    db.close()
  }
}

function createInterfaceDb(path: string): void {
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE interface_bindings (
        binding_id TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL,
        gateway_type TEXT NOT NULL,
        conversation_ref TEXT NOT NULL,
        thread_ref TEXT,
        lane_ref TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        role_name TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.query(
      `INSERT INTO interface_bindings (
         binding_id, gateway_id, gateway_type, conversation_ref, thread_ref, lane_ref,
         project_id, agent_id, task_id, role_name, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'binding-pass',
      'discord',
      'discord',
      'channel:1',
      null,
      'main',
      'agent-control-plane',
      'larry',
      'T-1',
      null,
      'active',
      '2026-06-18T00:00:00.000Z',
      '2026-06-18T00:00:00.000Z'
    )
    db.query(
      `INSERT INTO interface_bindings (
         binding_id, gateway_id, gateway_type, conversation_ref, thread_ref, lane_ref,
         project_id, agent_id, task_id, role_name, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'binding-fail',
      'discord',
      'discord',
      'channel:2',
      null,
      'not a lane',
      'agent-control-plane',
      'larry',
      'T-2',
      null,
      'active',
      '2026-06-18T00:00:00.000Z',
      '2026-06-18T00:00:00.000Z'
    )
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy shape audit', () => {
  test('audits jobs and interface bindings with real parser failures', () => {
    const root = tmpRoot()
    const jobsDbPath = join(root, 'acp-jobs.db')
    const interfaceDbPath = join(root, 'acp-interface.db')
    createJobsDb(jobsDbPath)
    createInterfaceDb(interfaceDbPath)

    const report = runLegacyShapeAudit({ jobsDbPath, interfaceDbPath })

    expect(report.readOnly).toBe(true)
    expect(report.summary.verdict).toBe('FAIL')
    expect(report.summary.jobs).toEqual({ total: 2, pass: 1, fail: 1 })
    expect(report.summary.interfaceBindings).toEqual({ total: 2, pass: 1, fail: 1 })
    expect(report.parserExports.map((parser) => parser.exportName)).toContain('validateJobTrigger')
    expect(report.parserExports.map((parser) => parser.exportName)).toContain('normalizeSessionRef')

    const failingJob = report.jobs.find((row) => row.id === 'job-fail')
    expect(failingJob?.failures).toContainEqual({
      check: 'trigger validation',
      error: 'trigger.cooldown must be a duration string like "5m" or "1h"',
    })
    expect(failingJob?.failures).toContainEqual({
      check: 'cooldown parse',
      error: 'unparseable cooldown: PT30S',
    })

    const failingBinding = report.interfaceBindings.find((row) => row.id === 'binding-fail')
    expect(failingBinding?.failures[0]?.check).toBe('lane_ref parse')

    const human = renderHumanReport(report)
    expect(human).toContain('[FAIL] jobs id=job-fail')
    expect(human).toContain('[FAIL] interface_bindings id=binding-fail')
  })
})
