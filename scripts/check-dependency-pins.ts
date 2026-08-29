/**
 * Pinned-dependency agreement guard.
 *
 * Exact versions in the root package.json `overrides` block are the workspace's
 * pin table. Every dependency and devDependency declaration for a governed
 * package must agree with that pin. Peer dependencies are compatibility
 * statements, so they are deliberately exempt.
 *
 * A floating declaration can materialize a nested node_modules copy that
 * shadows the root resolution for one workspace package. The lockfile can still
 * look coherent while TypeScript and runtime resolution use the nested copy.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/
const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp'])
const governedSections = ['dependencies', 'devDependencies'] as const

type PackageJson = {
  overrides?: unknown
  dependencies?: unknown
  devDependencies?: unknown
}

export type DependencyPinDiagnostic = {
  manifest: string
  line: number
  section: (typeof governedSections)[number]
  dependency: string
  expected: string
  actual: string
}

export type DependencyPinReport = {
  diagnostics: DependencyPinDiagnostic[]
}

type DependencyPinOptions = {
  rootDir?: string
}

type RenderedDiagnostics = {
  stdout: string
  stderr: string
  exitCode: 0 | 1
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function pinTable(rootContent: string): Map<string, string> {
  const overrides = asRecord((JSON.parse(rootContent) as PackageJson).overrides)
  const pins = new Map<string, string>()
  for (const [dependency, specifier] of Object.entries(overrides)) {
    if (typeof specifier === 'string' && exactVersion.test(specifier)) {
      pins.set(dependency, specifier)
    }
  }
  return pins
}

function declarationLine(content: string, dependency: string): number {
  const key = `"${dependency}"`
  const index = content.split('\n').findIndex((line) => line.trimStart().startsWith(`${key}:`))
  return index === -1 ? 1 : index + 1
}

async function manifestPaths(rootDir: string): Promise<string[]> {
  const manifests: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(join(directory, entry.name))
        }
        continue
      }

      if (entry.isFile() && entry.name === 'package.json') {
        manifests.push(relative(rootDir, join(directory, entry.name)).replaceAll('\\', '/'))
      }
    }
  }

  await walk(rootDir)
  return manifests.sort()
}

export async function runDependencyPinCheck(
  options: DependencyPinOptions = {}
): Promise<DependencyPinReport> {
  const rootDir = options.rootDir ?? process.cwd()
  const rootContent = await readFile(join(rootDir, 'package.json'), 'utf8')
  const pins = pinTable(rootContent)
  const diagnostics: DependencyPinDiagnostic[] = []

  for (const manifest of await manifestPaths(rootDir)) {
    const content =
      manifest === 'package.json' ? rootContent : await readFile(join(rootDir, manifest), 'utf8')
    const packageJson = JSON.parse(content) as PackageJson

    for (const section of governedSections) {
      for (const [dependency, specifier] of Object.entries(asRecord(packageJson[section]))) {
        const expected = pins.get(dependency)
        if (expected === undefined || specifier === expected) {
          continue
        }

        diagnostics.push({
          manifest,
          line: declarationLine(content, dependency),
          section,
          dependency,
          expected,
          actual: String(specifier),
        })
      }
    }
  }

  return {
    diagnostics: diagnostics.sort(
      (left, right) =>
        left.manifest.localeCompare(right.manifest) ||
        left.line - right.line ||
        left.dependency.localeCompare(right.dependency)
    ),
  }
}

export function renderDependencyPinDiagnostics(report: DependencyPinReport): RenderedDiagnostics {
  if (report.diagnostics.length === 0) {
    return { stdout: 'Dependency pin check passed.\n', stderr: '', exitCode: 0 }
  }

  const lines = [
    'Dependency pin check failed: workspace declarations disagree with exact root overrides.',
    '',
    'Why it matters:',
    '  Bun can install a separate nested copy for the disagreeing declaration. That copy shadows the root resolution for one package while the lockfile appears coherent.',
    'How to fix:',
    '  Make each declaration match the root override, run `bun install`, then run `just doctor` to prune stale nested copies.',
    '',
    'Mismatched declarations:',
  ]

  for (const diagnostic of report.diagnostics) {
    lines.push(
      `  ${diagnostic.manifest}:${diagnostic.line} ${diagnostic.section}.${diagnostic.dependency} is "${diagnostic.actual}"; expected "${diagnostic.expected}"`
    )
  }

  return { stdout: '', stderr: `${lines.join('\n')}\n`, exitCode: 1 }
}

if (import.meta.main) {
  const rendered = renderDependencyPinDiagnostics(await runDependencyPinCheck())
  if (rendered.stdout) process.stdout.write(rendered.stdout)
  if (rendered.stderr) process.stderr.write(rendered.stderr)
  process.exit(rendered.exitCode)
}
