#!/usr/bin/env bun
import { resolve } from 'node:path'

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
  all         Search routes, packages, and CLI together

Examples:
  bun scripts/discover-acp.ts routes "GET /v1/tasks/:taskId"
  bun scripts/discover-acp.ts routes pbc --json
  bun scripts/discover-acp.ts packages acp-server
  bun scripts/discover-acp.ts cli "task timeline"`)
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

async function discover(options: Options): Promise<JsonValue> {
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

  printRoutes(record.routes ?? [])
  console.log('')
  printPackages(record.packages ?? [])
  console.log('')
  printCli(record.cli ?? [])
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
