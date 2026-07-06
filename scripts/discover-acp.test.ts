import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { runAdoptionProbe } from './discover-acp.js'

const tmpRoots: string[] = []

function tmpRoot(): string {
  const root = join(tmpdir(), `acp-discover-adoption-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tmpRoots.push(root)
  return root
}

function withDatabase(path: string, sql: string): void {
  const db = new Database(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('discover-acp adoption probe', () => {
  test('reports store identity and boolean adoption predicates', () => {
    const root = tmpRoot()
    const jobsDbPath = join(root, 'acp-jobs.db')
    const stateDbPath = join(root, 'acp-state.db')
    const interfaceDbPath = join(root, 'acp-interface.db')

    withDatabase(
      jobsDbPath,
      `
        CREATE TABLE jobs (job_id TEXT PRIMARY KEY);
        CREATE TABLE job_runs (job_run_id TEXT PRIMARY KEY);
        INSERT INTO jobs (job_id) VALUES ('job_1');
      `
    )
    withDatabase(
      stateDbPath,
      `
        CREATE TABLE runs (run_id TEXT PRIMARY KEY);
        CREATE TABLE input_attempts (input_attempt_id TEXT PRIMARY KEY);
        CREATE TABLE workflow_events (event_id TEXT PRIMARY KEY);
        INSERT INTO runs (run_id) VALUES ('run_1');
        INSERT INTO workflow_events (event_id) VALUES ('event_1');
      `
    )
    withDatabase(
      interfaceDbPath,
      `
        CREATE TABLE interface_bindings (binding_id TEXT PRIMARY KEY);
        CREATE TABLE delivery_requests (delivery_request_id TEXT PRIMARY KEY);
        CREATE TABLE interface_message_sources (
          gateway_id TEXT NOT NULL,
          message_ref TEXT NOT NULL,
          PRIMARY KEY (gateway_id, message_ref)
        );
        INSERT INTO interface_bindings (binding_id) VALUES ('ifb_1');
        INSERT INTO delivery_requests (delivery_request_id) VALUES ('dr_1');
      `
    )

    const report = runAdoptionProbe({
      now: '2026-07-06T00:00:00.000Z',
      jobsDbPath,
      stateDbPath,
      interfaceDbPath,
      env: {},
    })

    expect(report.readOnly).toBe(true)
    expect(report.generatedAt).toBe('2026-07-06T00:00:00.000Z')
    expect(report.stores.jobs).toMatchObject({
      kind: 'jobs',
      path: jobsDbPath,
      pathSource: 'option',
      exists: true,
      error: null,
    })
    expect(report.stores.state.tables).toEqual({
      input_attempts: true,
      runs: true,
      workflow_events: true,
    })

    expect(report.predicates.jobs).toMatchObject({ available: true, hasRows: true })
    expect(report.predicates.jobRuns).toMatchObject({ available: true, hasRows: false })
    expect(report.predicates.runs).toMatchObject({ available: true, hasRows: true })
    expect(report.predicates.inputAttempts).toMatchObject({ available: true, hasRows: false })
    expect(report.predicates.workflowEvents).toMatchObject({ available: true, hasRows: true })
    expect(report.predicates.interfaceBindings).toMatchObject({ available: true, hasRows: true })
    expect(report.predicates.deliveryRequests).toMatchObject({ available: true, hasRows: true })
    expect(report.predicates.messageSources).toMatchObject({ available: true, hasRows: false })
  })

  test('keeps missing stores available as false instead of creating them', () => {
    const root = tmpRoot()
    const missingPath = join(root, 'missing.db')

    const report = runAdoptionProbe({
      jobsDbPath: missingPath,
      stateDbPath: missingPath,
      interfaceDbPath: missingPath,
      env: {},
    })

    expect(report.stores.jobs.exists).toBe(false)
    expect(report.predicates.jobs).toMatchObject({
      available: false,
      hasRows: false,
      error: 'database missing',
    })
    expect(report.predicates.messageSources).toMatchObject({
      available: false,
      hasRows: false,
      error: 'database missing',
    })
    expect(existsSync(missingPath)).toBe(false)
  })
})
