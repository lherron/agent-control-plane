/**
 * Prune stale nested copies of dependencies pinned by exact root overrides.
 *
 * `bun install` does not reliably remove a nested copy written for an older,
 * floating declaration. TypeScript resolves from the nearest node_modules, so
 * that stale copy can shadow the root even after manifests and bun.lock agree.
 * Only nested copies whose installed version differs from the root resolution
 * are removed. Matching copies and ungoverned dependencies are left alone.
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

function parseRoot(argv: string[]): string {
  const flag = argv.indexOf('--root')
  if (flag === -1) {
    return resolve(import.meta.dir, '..')
  }

  const value = argv[flag + 1]
  if (!value) {
    throw new Error('--root requires a directory')
  }
  return resolve(value)
}

const repoRoot = parseRoot(process.argv)
const skippedDirectories = new Set(['.git', 'coverage', 'dist', 'tmp'])
const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/

type PackageJson = { overrides?: unknown; version?: unknown }

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

async function readVersion(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(packageDir, 'package.json'), 'utf8')
    ) as PackageJson
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

async function governedDependencies(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as PackageJson
  return Object.entries(asRecord(manifest.overrides))
    .filter(([, specifier]) => typeof specifier === 'string' && exactVersion.test(specifier))
    .map(([dependency]) => dependency)
    .sort()
}

async function nestedCopies(dependency: string): Promise<string[]> {
  const rootCopy = join(repoRoot, 'node_modules', dependency)
  const found: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || skippedDirectories.has(entry.name)) {
        continue
      }

      const path = join(directory, entry.name)
      if (entry.name === 'node_modules') {
        const candidate = join(path, dependency)
        if (candidate !== rootCopy && (await readVersion(candidate)) !== undefined) {
          found.push(candidate)
        }
      }

      await walk(path)
    }
  }

  await walk(repoRoot)
  return found.sort()
}

const checkOnly = process.argv.includes('--check')
const dependencies = await governedDependencies()
let staleCount = 0

for (const dependency of dependencies) {
  const rootVersion = await readVersion(join(repoRoot, 'node_modules', dependency))
  for (const copy of await nestedCopies(dependency)) {
    const version = await readVersion(copy)
    const where = relative(repoRoot, copy)

    if (rootVersion === undefined) {
      console.warn(`[doctor] ${where}@${version}: no root resolution to compare against; kept`)
      continue
    }
    if (version === rootVersion) {
      continue
    }

    staleCount += 1
    console.log(`[doctor] ${where}@${version} shadows root ${dependency}@${rootVersion}`)
    if (!checkOnly) {
      await rm(copy, { recursive: true, force: true })
    }
  }
}

if (staleCount === 0) {
  console.log(
    `Workspace doctor: no stale nested copies of ${dependencies.length} pinned dependencies.`
  )
  process.exit(0)
}

if (checkOnly) {
  console.error(
    `Workspace doctor: ${staleCount} stale nested copy(ies) shadow the root resolution. Run \`just doctor\` to prune them.`
  )
  process.exit(1)
}

console.log(`Workspace doctor: pruned ${staleCount} stale nested copy(ies).`)
