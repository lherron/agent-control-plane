import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://127.0.0.1:4873/'

const PACKAGES = [
  'packages/acp-admin-store',
  'packages/acp-cli',
  'packages/acp-conversation',
  'packages/acp-core',
  'packages/acp-interface-store',
  'packages/acp-jobs-store',
  'packages/acp-ops-projection',
  'packages/acp-ops-reducer',
  'packages/acp-server',
  'packages/acp-state-store',
  'packages/coordination-substrate',
  'packages/gateway-discord',
  'packages/gateway-ios',
  'packages/wlearn',
  'packages/wrkq-lib',
] as const

type Manifest = {
  name?: string
  version?: string
  private?: boolean
  exports?: unknown
}

function run(cmd: string, args: string[], cwd = ROOT): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function stripBunConditions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBunConditions)
  if (!value || typeof value !== 'object') return value

  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'bun') continue
    next[key] = stripBunConditions(child)
  }
  return next
}

function findBunConditions(value: unknown, path = 'exports'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => findBunConditions(child, `${path}[${index}]`))
  }
  if (!value || typeof value !== 'object') return []

  const offenders: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`
    if (key === 'bun') offenders.push(childPath)
    offenders.push(...findBunConditions(child, childPath))
  }
  return offenders
}

function isNotPublished(output: string): boolean {
  return /E404|404 Not Found|not found/i.test(output)
}

async function packForPublish(rel: string): Promise<{
  name: string
  version: string
  tarballPath: string
  tmp: string
}> {
  const pkgDir = join(ROOT, rel)
  const packageJsonPath = join(pkgDir, 'package.json')
  const originalPackageJson = await readFile(packageJsonPath, 'utf8')
  let tmp = ''

  try {
    tmp = await mkdtemp(join(tmpdir(), 'acp-publish-'))
    const manifest = JSON.parse(originalPackageJson) as Manifest
    if (!manifest.name || !manifest.version) {
      throw new Error(`${rel}/package.json must include name and version`)
    }

    const publishManifest = {
      ...manifest,
      exports: stripBunConditions(manifest.exports),
    }
    delete publishManifest.private

    await writeFile(packageJsonPath, `${JSON.stringify(publishManifest, null, 2)}\n`)

    const pack = run('bun', ['pm', 'pack', '--destination', tmp, '--ignore-scripts'], pkgDir)
    if (pack.status !== 0) {
      throw new Error(`bun pm pack failed for ${manifest.name}: ${pack.out}`)
    }

    const entries = await readdir(tmp)
    const tarball = entries.find((entry) => entry.endsWith('.tgz'))
    if (!tarball) {
      throw new Error(`bun pm pack produced no tarball for ${manifest.name}`)
    }

    const extractDir = join(tmp, 'extract')
    const mkdir = run('mkdir', ['-p', extractDir])
    if (mkdir.status !== 0) throw new Error(`mkdir failed for ${manifest.name}: ${mkdir.out}`)

    const tarballPath = join(tmp, tarball)
    const tar = run('tar', ['-xzf', tarballPath, '-C', extractDir])
    if (tar.status !== 0) throw new Error(`tar failed for ${manifest.name}: ${tar.out}`)

    const stagedManifest = JSON.parse(
      await readFile(join(extractDir, 'package', 'package.json'), 'utf8')
    ) as Manifest
    const offenders = findBunConditions(stagedManifest.exports)
    if (offenders.length > 0) {
      throw new Error(
        `${manifest.name} tarball retains bun export conditions: ${offenders.join(', ')}`
      )
    }
    if (stagedManifest.private) {
      throw new Error(`${manifest.name} tarball still has private=true`)
    }

    return { name: manifest.name, version: manifest.version, tarballPath, tmp }
  } catch (error) {
    if (tmp) await rm(tmp, { recursive: true, force: true })
    throw error
  } finally {
    await writeFile(packageJsonPath, originalPackageJson)
  }
}

async function publishPackage(rel: string): Promise<void> {
  const packed = await packForPublish(rel)
  const id = `${packed.name}@${packed.version}`

  try {
    const unpublish = run('npm', ['unpublish', packed.name, '--force', '--registry', REGISTRY])
    if (unpublish.status !== 0 && !isNotPublished(unpublish.out)) {
      throw new Error(`npm unpublish failed for ${packed.name}: ${unpublish.out}`)
    }

    const publish = run('npm', [
      'publish',
      packed.tarballPath,
      '--ignore-scripts',
      '--registry',
      REGISTRY,
    ])
    if (publish.status !== 0) {
      throw new Error(`npm publish failed for ${id}: ${publish.out}`)
    }

    const view = run('npm', ['view', id, 'version', '--registry', REGISTRY])
    if (view.status !== 0 || view.out.trim() !== packed.version) {
      throw new Error(`npm view failed after publishing ${id}: ${view.out}`)
    }

    console.log(`PUBLISHED  ${id}`)
  } finally {
    await rm(packed.tmp, { recursive: true, force: true })
  }
}

async function main() {
  const ping = run('npm', ['ping', '--registry', REGISTRY])
  if (ping.status !== 0) {
    throw new Error(`Verdaccio is not reachable at ${REGISTRY}: ${ping.out}`)
  }

  console.log(`Publishing ${PACKAGES.length} ACP package(s) to ${REGISTRY}`)
  for (const rel of PACKAGES) {
    await publishPackage(rel)
  }
}

await main()
