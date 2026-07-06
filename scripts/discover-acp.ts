#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { Database } from 'bun:sqlite'
import { buildCliSurface } from './check-cli-surface.ts'
import { packageSurface } from './check-public-surface.ts'
import {
  type JsonValue,
  type RouteSummary,
  collectRouteSummaries,
  repoRoot,
  stable,
} from './lib/live-discovery.ts'

type Options = {
  root: string
  json: boolean
  command: string
  query: string
}

type PackageRecord = {
  name: string
  directory: string
  manifest: string
  bin: JsonValue
  exportKeys: string[]
  rootExportSource: JsonValue
  rootTypes: string[]
  rootValues: string[]
}

type StoreKind = 'jobs' | 'state' | 'interface'

type StoreProbe = {
  kind: StoreKind
  path: string
  pathSource: string
  exists: boolean
  tables: Record<string, boolean>
  error: string | null
}

type AdoptionPredicate = {
  store: StoreKind
  table: string
  hasRows: boolean
  available: boolean
  error: string | null
}

type AdoptionProbeReport = {
  generatedAt: string
  readOnly: true
  stores: Record<StoreKind, StoreProbe>
  predicates: {
    jobs: AdoptionPredicate
    jobRuns: AdoptionPredicate
    runs: AdoptionPredicate
    inputAttempts: AdoptionPredicate
    workflowEvents: AdoptionPredicate
    interfaceBindings: AdoptionPredicate
    deliveryRequests: AdoptionPredicate
    messageSources: AdoptionPredicate
  }
}

export type AdoptionProbeOptions = {
  now?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  jobsDbPath?: string | undefined
  stateDbPath?: string | undefined
  interfaceDbPath?: string | undefined
}

const DEFAULT_DB_ROOT = join(homedir(), 'praesidium/var/db')

const ADOPTION_TABLES = {
  jobs: ['jobs', 'job_runs'],
  state: ['runs', 'input_attempts', 'workflow_events'],
  interface: ['interface_bindings', 'delivery_requests', 'interface_message_sources'],
} as const satisfies Record<StoreKind, readonly string[]>

function parseArgs(argv: string[]): Options {
  const args = [...argv]
  let root = repoRoot
  let json = false

  for (let index = 0; index < args.length; ) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      args.splice(index, 1)
      continue
    }
    if (arg === '--root') {
      const value = args[index + 1]
      if (value === undefined) throw new Error('--root requires a path')
      root = resolve(value)
      args.splice(index, 2)
      continue
    }
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    index += 1
  }

  const command = args.shift() ?? 'all'
  return { root, json, command, query: args.join(' ').trim() }
}

function printUsage(): void {
  console.log(`Usage: bun scripts/discover-acp.ts [--json] [--root <path>] <area> [query]

Areas:
  routes      Find HTTP route owners and handler entry points
  packages    Find workspace packages and public export locations
  cli         Find ACP CLI command families and flags
  adoption    Probe live ACP store adoption predicates
  all         Search routes, packages, and CLI together

Examples:
  bun scripts/discover-acp.ts routes "GET /v1/tasks/:taskId"
  bun scripts/discover-acp.ts routes pbc --json
  bun scripts/discover-acp.ts packages acp-server
  bun scripts/discover-acp.ts cli "task timeline"
  bun scripts/discover-acp.ts adoption --json`)
}

function matches(query: string, values: Array<string | null | undefined>): boolean {
  if (query.length === 0) return true
  const normalized = query.toLowerCase()
  return values.some((value) => value?.toLowerCase().includes(normalized))
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`
}

function printRoutes(routes: RouteSummary[]): void {
  if (routes.length === 0) {
    console.log('No routes matched.')
    return
  }
  console.log(`${pad('route', 56)} ${pad('family', 14)} ${pad('handler', 38)} source`)
  for (const route of routes) {
    console.log(
      `${pad(route.key, 56)} ${pad(route.family, 14)} ${pad(route.handler ?? '-', 38)} ${
        route.handlerSource ?? route.source
      }`
    )
  }
}

function printPackages(packages: PackageRecord[]): void {
  if (packages.length === 0) {
    console.log('No packages matched.')
    return
  }
  console.log(`${pad('package', 30)} ${pad('directory', 34)} public surface`)
  for (const pkg of packages) {
    const exports =
      pkg.rootValues.length + pkg.rootTypes.length === 0
        ? '-'
        : `${pkg.rootValues.length} values, ${pkg.rootTypes.length} types`
    console.log(
      `${pad(pkg.name, 30)} ${pad(pkg.directory, 34)} ${pkg.rootExportSource ?? '-'} (${exports})`
    )
  }
}

function printCli(entries: ReturnType<typeof buildCliSurface>): void {
  if (entries.length === 0) {
    console.log('No CLI commands matched.')
    return
  }
  console.log(`${pad('command', 42)} ${pad('flags', 48)} description`)
  for (const entry of entries) {
    console.log(
      `${pad(entry.path, 42)} ${pad(entry.flags.length === 0 ? '-' : entry.flags.join(' '), 48)} ${
        entry.description ?? ''
      }`
    )
  }
}

function normalizePackages(packages: Record<string, JsonValue>): PackageRecord[] {
  return Object.entries(packages).map(([name, raw]) => {
    const record = raw as Record<string, JsonValue>
    const directory = `packages/${name.replace(/^@[^/]+\//, '').replace(/^acp-/, 'acp-')}`
    return {
      name,
      directory,
      manifest: `${directory}/package.json`,
      bin: record['bin'] ?? {},
      exportKeys: Array.isArray(record['exportKeys']) ? (record['exportKeys'] as string[]) : [],
      rootExportSource: record['rootExportSource'] ?? null,
      rootTypes: Array.isArray(record['rootTypes']) ? (record['rootTypes'] as string[]) : [],
      rootValues: Array.isArray(record['rootValues']) ? (record['rootValues'] as string[]) : [],
    }
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolvePath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  envNames: readonly string[],
  defaultPath: string
): { path: string; source: string } {
  if (explicit !== undefined) return { path: explicit, source: 'option' }
  for (const envName of envNames) {
    const value = env[envName]
    if (value !== undefined && value.length > 0) return { path: value, source: `env:${envName}` }
  }
  return { path: defaultPath, source: 'default' }
}

function openReadOnlyDatabase(path: string): Database {
  const database = new Database(path, { readonly: true })
  database.exec('PRAGMA query_only = ON;')
  return database
}

function tableExists(database: Database, table: string): boolean {
  const row = database
    .query(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(table) as { found: number } | null
  return row !== null
}

function tableHasRows(database: Database, table: string): boolean {
  const row = database.query(`SELECT EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS present`).get() as {
    present: number
  }
  return row.present === 1
}

function probeStore(kind: StoreKind, path: string, pathSource: string): StoreProbe {
  const tableNames = ADOPTION_TABLES[kind]
  const tables = Object.fromEntries(tableNames.map((table) => [table, false]))

  if (!existsSync(path)) {
    return { kind, path, pathSource, exists: false, tables, error: null }
  }

  let database: Database | undefined
  try {
    database = openReadOnlyDatabase(path)
    for (const table of tableNames) tables[table] = tableExists(database, table)
    return { kind, path, pathSource, exists: true, tables, error: null }
  } catch (error) {
    return { kind, path, pathSource, exists: true, tables, error: errorMessage(error) }
  } finally {
    database?.close()
  }
}

function probePredicate(store: StoreProbe, table: string): AdoptionPredicate {
  const available = store.exists && store.error === null && store.tables[table] === true
  if (!available) {
    return {
      store: store.kind,
      table,
      hasRows: false,
      available: false,
      error: store.error ?? (store.exists ? 'table missing' : 'database missing'),
    }
  }

  let database: Database | undefined
  try {
    database = openReadOnlyDatabase(store.path)
    return {
      store: store.kind,
      table,
      hasRows: tableHasRows(database, table),
      available: true,
      error: null,
    }
  } catch (error) {
    return {
      store: store.kind,
      table,
      hasRows: false,
      available: false,
      error: errorMessage(error),
    }
  } finally {
    database?.close()
  }
}

export function runAdoptionProbe(options: AdoptionProbeOptions = {}): AdoptionProbeReport {
  const env = options.env ?? process.env
  const jobsPath = resolvePath(
    options.jobsDbPath,
    env,
    ['ACP_JOBS_DB_PATH', 'ACP_JOBS_DB'],
    join(DEFAULT_DB_ROOT, 'acp-jobs.db')
  )
  const statePath = resolvePath(
    options.stateDbPath,
    env,
    ['ACP_STATE_DB_PATH', 'ACP_STATE_DB'],
    join(DEFAULT_DB_ROOT, 'acp-state.db')
  )
  const interfacePath = resolvePath(
    options.interfaceDbPath,
    env,
    ['ACP_INTERFACE_DB_PATH', 'ACP_INTERFACE_DB'],
    join(DEFAULT_DB_ROOT, 'acp-interface.db')
  )

  const stores = {
    jobs: probeStore('jobs', jobsPath.path, jobsPath.source),
    state: probeStore('state', statePath.path, statePath.source),
    interface: probeStore('interface', interfacePath.path, interfacePath.source),
  }

  return {
    generatedAt: options.now ?? new Date().toISOString(),
    readOnly: true,
    stores,
    predicates: {
      jobs: probePredicate(stores.jobs, 'jobs'),
      jobRuns: probePredicate(stores.jobs, 'job_runs'),
      runs: probePredicate(stores.state, 'runs'),
      inputAttempts: probePredicate(stores.state, 'input_attempts'),
      workflowEvents: probePredicate(stores.state, 'workflow_events'),
      interfaceBindings: probePredicate(stores.interface, 'interface_bindings'),
      deliveryRequests: probePredicate(stores.interface, 'delivery_requests'),
      messageSources: probePredicate(stores.interface, 'interface_message_sources'),
    },
  }
}

async function discover(options: Options): Promise<JsonValue> {
  if (options.command === 'adoption' || options.command === 'adopt') {
    return stable(runAdoptionProbe()) as JsonValue
  }

  const routeRecords = await collectRouteSummaries(options.root)
  const packageRecords = normalizePackages(
    (await packageSurface(options.root)) as Record<string, JsonValue>
  )
  const cliRecords = buildCliSurface()

  const routes = routeRecords.filter((route) =>
    matches(options.query, [
      route.key,
      route.family,
      route.handler,
      route.handlerSource,
      route.source,
    ])
  )
  const packages = packageRecords.filter((pkg) =>
    matches(options.query, [
      pkg.name,
      pkg.directory,
      pkg.manifest,
      String(pkg.rootExportSource ?? ''),
      ...pkg.exportKeys,
      ...pkg.rootTypes,
      ...pkg.rootValues,
    ])
  )
  const cli = cliRecords.filter((entry) =>
    matches(options.query, [entry.path, entry.description, ...entry.flags])
  )

  switch (options.command) {
    case 'route':
    case 'routes':
    case 'handler':
    case 'handlers':
      return stable({ routes }) as JsonValue
    case 'package':
    case 'packages':
    case 'public':
      return stable({ packages }) as JsonValue
    case 'cli':
    case 'command':
    case 'commands':
      return stable({ cli }) as JsonValue
    case 'adoption':
    case 'adopt':
      return stable(runAdoptionProbe()) as JsonValue
    case 'all':
      return stable({ routes, packages, cli }) as JsonValue
    default:
      throw new Error(`unknown discovery area: ${options.command}`)
  }
}

function printText(command: string, result: JsonValue): void {
  const record = result as {
    routes?: RouteSummary[]
    packages?: PackageRecord[]
    cli?: ReturnType<typeof buildCliSurface>
  }
  if (
    command === 'route' ||
    command === 'routes' ||
    command === 'handler' ||
    command === 'handlers'
  ) {
    printRoutes(record.routes ?? [])
    return
  }
  if (command === 'package' || command === 'packages' || command === 'public') {
    printPackages(record.packages ?? [])
    return
  }
  if (command === 'cli' || command === 'command' || command === 'commands') {
    printCli(record.cli ?? [])
    return
  }
  if (command === 'adoption' || command === 'adopt') {
    printAdoption(result as AdoptionProbeReport)
    return
  }

  printRoutes(record.routes ?? [])
  console.log('')
  printPackages(record.packages ?? [])
  console.log('')
  printCli(record.cli ?? [])
}

function printAdoption(report: AdoptionProbeReport): void {
  console.log(`ACP adoption probe (${report.generatedAt})`)
  console.log('')
  console.log(`${pad('store', 12)} ${pad('exists', 8)} path`)
  for (const store of Object.values(report.stores)) {
    console.log(`${pad(store.kind, 12)} ${pad(String(store.exists), 8)} ${store.path}`)
  }
  console.log('')
  console.log(`${pad('predicate', 20)} ${pad('available', 10)} hasRows`)
  for (const [name, predicate] of Object.entries(report.predicates)) {
    console.log(
      `${pad(name, 20)} ${pad(String(predicate.available), 10)} ${String(predicate.hasRows)}`
    )
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const result = await discover(options)
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  printText(options.command, result)
}

if (import.meta.main) {
  await main()
}
