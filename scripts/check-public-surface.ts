#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import * as ts from 'typescript'

import { buildProgram } from '../packages/acp-cli/src/cli.js'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface PackageManifest {
  name?: string
  bin?: Record<string, string> | string
  exports?: Record<string, unknown>
}

interface ExportSurface {
  values: Set<string>
  types: Set<string>
}

interface Violation {
  where: string
  failed: string
  why: string
  fix: string
}

interface Options {
  root: string
  write: boolean
  selfTest: boolean
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const baselineRel = join('scripts', 'fixtures', 'public-surface', 'acp-public-surface.json')
const docRels = [
  'docs/ACP_JOBS_TASKS_USAGE.md',
  'docs/agent-control-plane-current-spec.md',
  'packages/acp-cli/README.md',
  'packages/acp-server/README.md',
  'packages/gateway-ios/SMOKE.md',
]
const routeSourceRels = [
  'packages/acp-server/src/routing/exact-routes.ts',
  'packages/acp-server/src/routing/param-routes.ts',
  'packages/gateway-ios/src/routes.ts',
]
const capSmokeRel = 'scripts/e2e/cap-acp/smoke.sh'

function parseArgs(argv: string[]): Options {
  const options: Options = { root: repoRoot, write: false, selfTest: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      index += 1
      if (argv[index] === undefined) throw new Error('--root requires a path')
      options.root = resolve(argv[index])
    } else if (arg === '--write') {
      options.write = true
    } else if (arg === '--self-test') {
      options.selfTest = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun scripts/check-public-surface.ts [--root <path>] [--write] [--self-test]'
      )
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function rel(path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

async function readText(root: string, path: string): Promise<string> {
  return await readFile(join(root, path), 'utf8')
}

function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)])
    )
  }
  return value
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function emptySurface(): ExportSurface {
  return { values: new Set<string>(), types: new Set<string>() }
}

function mergeSurface(target: ExportSurface, source: ExportSurface): void {
  for (const value of source.values) target.values.add(value)
  for (const type of source.types) target.types.add(type)
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  )
}

function collectBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names)
  }
}

function addExportedDeclaration(surface: ExportSurface, node: ts.Node): void {
  if (!hasExportModifier(node)) return

  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    surface.types.add(node.name.text)
    return
  }

  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
    if (node.name !== undefined) surface.values.add(node.name.text)
    return
  }

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      collectBindingNames(declaration.name, surface.values)
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists()
}

async function resolveLocalModule(
  root: string,
  fromRel: string,
  specifier: string
): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined
  const fromAbs = join(root, fromRel)
  const raw = resolve(dirname(fromAbs), specifier)
  const candidates = raw.endsWith('.js')
    ? [raw.replace(/\.js$/, '.ts'), raw.replace(/\.js$/, '.tsx')]
    : [`${raw}.ts`, `${raw}.tsx`, join(raw, 'index.ts'), join(raw, 'index.tsx')]

  for (const candidate of candidates) {
    if (await exists(candidate)) return rel(candidate)
  }
  return undefined
}

async function collectExports(
  root: string,
  entryRel: string,
  seen = new Set<string>()
): Promise<ExportSurface> {
  if (seen.has(entryRel)) return emptySurface()
  seen.add(entryRel)

  const text = await readText(root, entryRel)
  const source = ts.createSourceFile(entryRel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const surface = emptySurface()

  for (const statement of source.statements) {
    addExportedDeclaration(surface, statement)

    if (!ts.isExportDeclaration(statement)) continue
    const moduleSpecifier = statement.moduleSpecifier
    const specifier =
      moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)
        ? moduleSpecifier.text
        : undefined

    if (statement.exportClause === undefined) {
      if (specifier === undefined) continue
      const local = await resolveLocalModule(root, entryRel, specifier)
      if (local !== undefined) mergeSurface(surface, await collectExports(root, local, seen))
      continue
    }

    if (!ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      const target = statement.isTypeOnly || element.isTypeOnly ? surface.types : surface.values
      target.add(element.name.text)
    }
  }

  return surface
}

async function packageSurface(root: string): Promise<JsonValue> {
  const packageJsonPaths = sorted(
    (await Array.fromAsync(new Bun.Glob('packages/*/package.json').scan(root))).map(String)
  )
  const packages: Record<string, JsonValue> = {}
  for (const manifestRel of packageJsonPaths) {
    const manifest = JSON.parse(await readText(root, manifestRel)) as PackageManifest
    if (manifest.name === undefined) throw new Error(`${manifestRel}: missing package name`)
    const entryRel = manifestRel.replace(/package\.json$/, 'src/index.ts')
    const hasEntry = await exists(join(root, entryRel))
    const exportedEntry = (manifest.exports?.['.'] as Record<string, unknown> | undefined)?.['bun']
    const surface = hasEntry ? await collectExports(root, entryRel) : emptySurface()
    packages[manifest.name] = {
      bin:
        typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {}),
      exportKeys: Object.keys(manifest.exports ?? {}),
      rootExportSource: exportedEntry ?? null,
      rootTypes: sorted(surface.types),
      rootValues: sorted(surface.values),
    }
  }
  return packages
}

function optionFlags(command: Command): string[] {
  return sorted(
    command.options.flatMap((option) =>
      option.flags
        .split(/[ ,|]+/)
        .filter((flag) => flag.startsWith('--'))
        .map((flag) => flag.replace(/[<[].*$/, ''))
    )
  )
}

function collectCliCommand(command: Command, prefix: string[] = []): JsonValue[] {
  const current = [...prefix, command.name()]
  const own = {
    path: current.join(' '),
    description: command.description(),
    options: optionFlags(command),
  }
  const children = command.commands.flatMap((child) => collectCliCommand(child, current))
  return [own, ...children]
}

function cliSurface(): JsonValue {
  const program = buildProgram({}, [])
  return {
    command: 'acp',
    commands: collectCliCommand(program),
  }
}

function extractRoutes(source: string): string[] {
  const routes = [
    ...source.matchAll(/exactRouteKey\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g),
    ...source.matchAll(/createParamRoute\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g),
    ...source.matchAll(/method:\s*'([A-Z]+)'[\s\S]*?path:\s*'([^']+)'/g),
  ]
  return sorted(routes.map((match) => `${match[1]} ${match[2]}`))
}

async function apiSurface(root: string): Promise<JsonValue> {
  const routes: string[] = []
  for (const sourceRel of routeSourceRels) {
    routes.push(...extractRoutes(await readText(root, sourceRel)))
  }
  if (routes.length === 0) throw new Error('no ACP routes found in routing sources')
  return {
    routes: sorted(routes),
  }
}

async function capabilitySurface(root: string): Promise<JsonValue> {
  const source = await readText(root, capSmokeRel)
  const aliases = sorted(
    [...source.matchAll(/'((?:acp|pbc)\.[a-z0-9_.]+)'\s*:/g)].map((match) => match[1] ?? '')
  )
  if (aliases.length === 0) throw new Error(`${capSmokeRel}: no capability aliases found`)
  return {
    smokeAliases: aliases,
  }
}

function normalizeCliReference(command: string): string {
  return command
    .replace(/\s+/g, ' ')
    .replace(/\s+\\$/g, '')
    .trim()
}

function extractDocCliReferences(text: string): string[] {
  return sorted(
    [...text.matchAll(/(?:^|\n)\s*(?:\$ )?(acp(?:\s+[a-z][a-z0-9-]*)+)(?:\s|$)/g)]
      .map((match) => normalizeCliReference(match[1] ?? ''))
      .filter((command) => command !== 'acp server')
  )
}

function extractDocApiReferences(text: string): string[] {
  return sorted(
    [...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[A-Za-z0-9_./:-]+)/g)].map(
      (match) => `${match[1]} ${match[2]}`
    )
  )
}

function extractDocCapabilityReferences(text: string): string[] {
  return sorted(
    [...text.matchAll(/\b((?:acp|pbc)\.[a-z0-9_.]+)\b/g)].map((match) => match[1] ?? '')
  )
}

function routeMatches(reference: string, routes: Set<string>): boolean {
  if (routes.has(reference)) return true
  const [method, path] = reference.split(' ', 2)
  for (const route of routes) {
    const [routeMethod, template] = route.split(' ', 2)
    if (method !== routeMethod) continue
    const pattern = new RegExp(
      `^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\:([A-Za-z0-9_]+)/g, '[^/]+')}$`
    )
    if (pattern.test(path)) return true
  }
  return false
}

function cliMatches(reference: string, commandPaths: Set<string>): boolean {
  const tokens = reference.split(/\s+/)
  while (tokens.length > 1) {
    if (commandPaths.has(tokens.join(' '))) return true
    tokens.pop()
  }
  return false
}

async function docsSurface(
  root: string,
  actual: { routes: string[]; cliCommands: string[]; capabilities: string[] }
): Promise<JsonValue> {
  const routes = new Set(actual.routes)
  const commands = new Set(actual.cliCommands)
  const capabilities = new Set(actual.capabilities)
  const docs: Record<string, JsonValue> = {}
  const violations: Violation[] = []

  for (const docRel of docRels) {
    const text = await readText(root, docRel)
    const apiReferences = extractDocApiReferences(text)
    const cliReferences = extractDocCliReferences(text)
    const capabilityReferences = extractDocCapabilityReferences(text)

    for (const reference of apiReferences) {
      if (!routeMatches(reference, routes)) {
        violations.push({
          where: docRel,
          failed: reference,
          why: 'The documented HTTP route is not present in the live ACP route registrations.',
          fix: 'Update the document or add the reviewed route intentionally.',
        })
      }
    }

    for (const reference of cliReferences) {
      if (!cliMatches(reference, commands)) {
        violations.push({
          where: docRel,
          failed: reference,
          why: 'The documented ACP CLI command path is not present in the live Commander tree.',
          fix: 'Update the document or add the reviewed CLI command intentionally.',
        })
      }
    }

    for (const reference of capabilityReferences) {
      if (!capabilities.has(reference)) {
        violations.push({
          where: docRel,
          failed: reference,
          why: 'The documented capability alias is not present in the cap-acp smoke alias set.',
          fix: 'Update the document or add the reviewed capability alias intentionally.',
        })
      }
    }

    docs[docRel] = {
      apiReferences,
      capabilityReferences,
      cliReferences,
    }
  }

  if (violations.length > 0) reportViolations(violations)
  return docs
}

async function collectActual(root: string): Promise<JsonValue> {
  const packages = await packageSurface(root)
  const cli = cliSurface() as { commands: Array<{ path: string }> }
  const api = (await apiSurface(root)) as { routes: string[] }
  const capabilities = (await capabilitySurface(root)) as { smokeAliases: string[] }
  const docs = await docsSurface(root, {
    routes: api.routes,
    cliCommands: cli.commands.map((command) => command.path),
    capabilities: capabilities.smokeAliases,
  })

  return stable({
    surface: 'agent-control-plane public surface',
    derivedFrom: [
      'packages/*/package.json',
      'packages/*/src/index.ts',
      'packages/acp-cli/src/cli.ts',
      ...routeSourceRels,
      capSmokeRel,
      ...docRels,
    ],
    packages,
    cli,
    api,
    capabilities,
    docs,
  })
}

function diffJson(expected: JsonValue, actual: JsonValue): string {
  const expectedLines = JSON.stringify(expected, null, 2).split('\n')
  const actualLines = JSON.stringify(actual, null, 2).split('\n')
  const max = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < max; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      const start = Math.max(0, index - 4)
      const end = Math.min(max, index + 8)
      return [
        `first difference near line ${index + 1}:`,
        ...Array.from({ length: end - start }, (_, offset) => {
          const line = start + offset
          return [
            expectedLines[line] === actualLines[line] ? ' ' : '-',
            String(line + 1).padStart(4, ' '),
            expectedLines[line] ?? '<missing>',
            expectedLines[line] === actualLines[line]
              ? ''
              : `\n+${String(line + 1).padStart(4, ' ')} ${actualLines[line] ?? '<missing>'}`,
          ].join(' ')
        }),
      ].join('\n')
    }
  }
  return 'JSON differs but no line delta was found'
}

function reportViolations(violations: Violation[]): never {
  console.error('public-surface: documented surface drift detected')
  for (const violation of violations) {
    console.error(`\n${violation.where}: ${violation.failed}`)
    console.error(`  why: ${violation.why}`)
    console.error(`  fix: ${violation.fix}`)
  }
  process.exit(1)
}

async function readBaseline(root: string): Promise<JsonValue> {
  return JSON.parse(await readText(root, baselineRel)) as JsonValue
}

async function writeBaseline(root: string, actual: JsonValue): Promise<void> {
  const baselinePath = join(root, baselineRel)
  await mkdir(dirname(baselinePath), { recursive: true })
  await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`)
}

async function selfTest(root: string, actual: JsonValue): Promise<void> {
  const mutated = structuredClone(actual) as Record<string, JsonValue>
  mutated['selfTestMutation'] = 'synthetic drift'
  if (JSON.stringify(mutated) === JSON.stringify(actual)) {
    throw new Error('self-test failed to mutate collected surface')
  }
  const expected = await readBaseline(root)
  if (JSON.stringify(expected) === JSON.stringify(mutated)) {
    throw new Error('self-test mutation unexpectedly matched baseline')
  }
  console.error('public-surface: self-test produced synthetic drift as expected')
  process.exit(1)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const actual = await collectActual(options.root)

  if (options.write) {
    await writeBaseline(options.root, actual)
    console.log(`public-surface: wrote ${baselineRel}`)
    return
  }

  if (options.selfTest) {
    await selfTest(options.root, actual)
  }

  const expected = await readBaseline(options.root)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    console.error('public-surface: baseline drift detected')
    console.error(diffJson(expected, actual))
    console.error('\nReview the change, then run: bun scripts/check-public-surface.ts --write')
    process.exit(1)
  }

  console.log(
    'public-surface: baseline matches live package, CLI, API, capability, and doc references'
  )
}

await main()
