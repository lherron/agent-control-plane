#!/usr/bin/env bun

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { Database } from 'bun:sqlite'

export type ResidueMonth = {
  month: string
  count: number
}

export type AcpsE2eResidueReport = {
  databasePath: string
  count: number
  oldest: string | null
  newest: string | null
  byMonth: ResidueMonth[]
}

type ResidueSummaryRow = {
  count: number
  oldest: string | null
  newest: string | null
}

type ResidueMonthRow = {
  month: string
  count: number
}

type CliOptions = {
  dryRun: boolean
  databasePath: string
  json: boolean
}

const ACPS_E2E_SCOPE_GLOB =
  'agent:*:project:acps-e2e-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]:task:*'

function defaultDatabasePath(env: NodeJS.ProcessEnv): string {
  const explicit = env['HRC_STATE_DB_PATH']?.trim()
  if (explicit) return resolve(explicit)

  const stateDir = env['HRC_STATE_DIR']?.trim()
  if (stateDir) return join(resolve(stateDir), 'state.sqlite')

  const praesidiumRoot = env['PRAESIDIUM_ROOT']?.trim()
  return join(
    praesidiumRoot ? resolve(praesidiumRoot) : join(homedir(), 'praesidium'),
    'var/state/hrc/state.sqlite'
  )
}

export function parseAcpsE2eResidueArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): CliOptions {
  let dryRun = false
  let databasePath = defaultDatabasePath(env)
  let json = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--db') {
      const value = argv[++index]
      if (!value) throw new Error('--db requires a path')
      databasePath = resolve(value)
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  if (!dryRun) {
    throw new Error('refusing to inspect residue without the explicit --dry-run flag')
  }
  return { dryRun, databasePath, json }
}

export function collectAcpsE2eResidue(databasePath: string): AcpsE2eResidueReport {
  const database = new Database(databasePath, { readonly: true })
  try {
    database.exec('PRAGMA query_only = ON;')
    const commonTableExpression = `
      WITH residue_scopes AS (
        SELECT scope_ref, MIN(created_at) AS created_at
        FROM sessions
        WHERE scope_ref GLOB ?
        GROUP BY scope_ref
      )
    `
    const summary = database
      .query<ResidueSummaryRow, [string]>(
        `${commonTableExpression}
         SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest
         FROM residue_scopes`
      )
      .get(ACPS_E2E_SCOPE_GLOB)
    const byMonth = database
      .query<ResidueMonthRow, [string]>(
        `${commonTableExpression}
         SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
         FROM residue_scopes
         GROUP BY month
         ORDER BY month`
      )
      .all(ACPS_E2E_SCOPE_GLOB)

    return {
      databasePath: resolve(databasePath),
      count: summary?.count ?? 0,
      oldest: summary?.oldest ?? null,
      newest: summary?.newest ?? null,
      byMonth,
    }
  } finally {
    database.close()
  }
}

export function renderAcpsE2eResidue(report: AcpsE2eResidueReport): string {
  const byMonth =
    report.byMonth.length === 0
      ? '  (none)'
      : report.byMonth.map((row) => `  ${row.month}: ${row.count}`).join('\n')
  return [
    'ACPS E2E residue dry-run',
    `database: ${report.databasePath}`,
    `count: ${report.count}`,
    `oldest: ${report.oldest ?? '(none)'}`,
    `newest: ${report.newest ?? '(none)'}`,
    'by month:',
    byMonth,
    'No rows were changed.',
  ].join('\n')
}

export function runAcpsE2eResidueCli(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const options = parseAcpsE2eResidueArgs(argv, env)
  const report = collectAcpsE2eResidue(options.databasePath)
  return options.json ? JSON.stringify(report, null, 2) : renderAcpsE2eResidue(report)
}

if (import.meta.main) {
  try {
    console.log(runAcpsE2eResidueCli(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
