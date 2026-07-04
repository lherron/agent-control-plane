import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

type PackageInfo = {
  dir: string
  name: string
  declared: Set<string>
}

export type MissingManifestEdge = {
  packageDir: string
  packageName: string
  dependency: string
  files: string[]
}

type PackageJson = {
  name?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  peerDependencies?: unknown
}

export type ManifestEdgeReport = {
  missingEdges: MissingManifestEdge[]
}

type ManifestEdgeOptions = {
  rootDir?: string
}

type RenderedDiagnostics = {
  stdout: string
  stderr: string
  exitCode: 0 | 1
}

const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp'])

async function pathExists(rootDir: string, path: string): Promise<boolean> {
  try {
    await readdir(join(rootDir, path))
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

async function readPackageInfo(rootDir: string, dir: string): Promise<PackageInfo | undefined> {
  let packageJsonContent: string
  try {
    packageJsonContent = await readFile(join(rootDir, dir, 'package.json'), 'utf8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return undefined
    }
    throw error
  }

  const packageJson = JSON.parse(packageJsonContent) as PackageJson
  if (typeof packageJson.name !== 'string') {
    return undefined
  }

  const declared = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    for (const dependency of Object.keys(asRecord(packageJson[field]))) {
      declared.add(dependency)
    }
  }

  return {
    dir,
    name: packageJson.name,
    declared,
  }
}

async function workspacePackages(rootDir: string): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = []
  const packageRootEntries = await readdir(join(rootDir, 'packages'), { withFileTypes: true })

  for (const entry of packageRootEntries) {
    if (!entry.isDirectory()) {
      continue
    }

    const info = await readPackageInfo(rootDir, join('packages', entry.name))
    if (info) {
      packages.push(info)
    }
  }

  if (await pathExists(rootDir, 'integration-tests')) {
    const integrationInfo = await readPackageInfo(rootDir, 'integration-tests')
    if (integrationInfo) {
      packages.push(integrationInfo)
    }
  }

  return packages.sort((left, right) => left.dir.localeCompare(right.dir))
}

async function collectSourceFiles(rootDir: string, srcDir: string): Promise<string[]> {
  if (!(await pathExists(rootDir, srcDir))) {
    return []
  }

  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(path)
        }
        continue
      }

      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(path)
      }
    }
  }

  await walk(join(rootDir, srcDir))
  return files.sort()
}

function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined
  }

  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    const scope = parts[0]
    const name = parts[1]
    return scope && name ? `${scope}/${name}` : undefined
  }

  return parts[0]
}

async function importedWorkspacePackages(
  rootDir: string,
  packageInfo: PackageInfo,
  workspaceNames: Set<string>
): Promise<Map<string, Set<string>>> {
  const imports = new Map<string, Set<string>>()
  const files = await collectSourceFiles(rootDir, join(packageInfo.dir, 'src'))

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) {
        continue
      }

      const packageName = barePackageName(specifier)
      if (!packageName || packageName === packageInfo.name || !workspaceNames.has(packageName)) {
        continue
      }

      const importFiles = imports.get(packageName) ?? new Set<string>()
      importFiles.add(relative(rootDir, file).replaceAll('\\', '/'))
      imports.set(packageName, importFiles)
    }
  }

  return imports
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = grouped.get(key) ?? []
    group.push(item)
    grouped.set(key, group)
  }
  return grouped
}

export async function runManifestEdgeCheck(
  options: ManifestEdgeOptions = {}
): Promise<ManifestEdgeReport> {
  const rootDir = options.rootDir ?? process.cwd()
  const packages = await workspacePackages(rootDir)
  const workspaceNames = new Set(packages.map((packageInfo) => packageInfo.name))
  const missingEdges: MissingManifestEdge[] = []

  for (const packageInfo of packages) {
    const imports = await importedWorkspacePackages(rootDir, packageInfo, workspaceNames)
    for (const [dependency, files] of imports) {
      if (!packageInfo.declared.has(dependency)) {
        missingEdges.push({
          packageDir: packageInfo.dir,
          packageName: packageInfo.name,
          dependency,
          files: [...files].sort(),
        })
      }
    }
  }

  return { missingEdges }
}

export function renderManifestDiagnostics(report: ManifestEdgeReport): RenderedDiagnostics {
  if (report.missingEdges.length === 0) {
    return { stdout: 'Manifest edge check passed.\n', stderr: '', exitCode: 0 }
  }

  const lines = [
    'Manifest edge check failed: source imports missing from package manifests.',
    '',
    'What failed:',
    '  A package imports another workspace package from src/ but does not declare that package in dependencies, devDependencies, or peerDependencies.',
    'Why it matters:',
    '  Package manifests are the install, publish, and repo-split contract; undeclared edges can pass locally while failing after isolated install or package extraction.',
    'How to fix:',
    '  Add the imported workspace package to the importing package manifest, or remove/move the import so the package no longer owns that edge.',
    'Exception path:',
    '  Runtime source edges should not be suppressed. If an edge is intentionally test-only or tool-only, move it out of src/ or add a documented devDependency plus a checker fixture.',
    '',
    'Missing edge details:',
  ]

  const grouped = groupBy(report.missingEdges, (edge) => `${edge.packageDir} (${edge.packageName})`)
  for (const [group, edges] of grouped) {
    lines.push('', group)
    for (const edge of edges.sort((left, right) =>
      left.dependency.localeCompare(right.dependency)
    )) {
      lines.push(`  missing dependency '${edge.dependency}'`)
      for (const file of edge.files) {
        lines.push(`    ${file}`)
      }
    }
  }

  return { stdout: '', stderr: `${lines.join('\n')}\n`, exitCode: 1 }
}

if (import.meta.main) {
  const rendered = renderManifestDiagnostics(await runManifestEdgeCheck())
  if (rendered.stderr) {
    console.error(rendered.stderr.trimEnd())
  }
  if (rendered.stdout) {
    console.log(rendered.stdout.trimEnd())
  }
  process.exit(rendered.exitCode)
}
