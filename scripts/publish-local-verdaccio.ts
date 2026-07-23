import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://mini:4873/'

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

type Options = {
  channel?: 'dev' | 'worktree'
  dryRun: boolean
  force: boolean
  tag?: string
  version?: string
}

type RegistryMetadata = {
  versions?: Record<string, unknown>
}

function run(cmd: string, args: string[], cwd = ROOT): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, force: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--channel') {
      const value = argv[++i]
      if (value !== 'dev' && value !== 'worktree') {
        throw new Error('--channel must be "dev" or "worktree"')
      }
      options.channel = value
    } else if (arg.startsWith('--channel=')) {
      const value = arg.slice('--channel='.length)
      if (value !== 'dev' && value !== 'worktree') {
        throw new Error('--channel must be "dev" or "worktree"')
      }
      options.channel = value
    } else if (arg === '--tag') {
      const value = argv[++i]
      if (!value) throw new Error('--tag requires a value')
      options.tag = value
    } else if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
    } else if (arg === '--version') {
      const value = argv[++i]
      if (!value) throw new Error('--version requires a value')
      options.version = value
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length)
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/publish-local-verdaccio.ts [--dry-run]
  bun scripts/publish-local-verdaccio.ts --channel worktree [--dry-run]
  bun scripts/publish-local-verdaccio.ts --version <semver> [--tag <tag>] [--force] [--dry-run]

Default mode republishes each ACP package at its source version tagged latest.
Worktree channel publishes <base>-worktree.YYYYMMDDHHMMSS.<shortsha> tagged worktree.`)
}

function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

function gitShortSha(): string {
  const result = run('git', ['rev-parse', '--short=12', 'HEAD'])
  return result.status === 0 && result.out.trim() ? result.out.trim() : 'nogit'
}

export function timestampVersion(
  baseVersion: string,
  channel: 'worktree',
  now = new Date(),
  shortSha = gitShortSha()
): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return `${baseVersion.split('-')[0]}-${channel}.${stamp}.${shortSha}`
}

function resolveTag(options: Options): string {
  return options.tag ?? (options.channel === 'worktree' ? 'worktree' : 'latest')
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

async function registryMetadata(name: string): Promise<RegistryMetadata | undefined> {
  const response = await fetch(`${REGISTRY.replace(/\/$/, '')}/${encodeURIComponent(name)}`)
  if (!response.ok) return undefined
  return (await response.json()) as RegistryMetadata
}

async function versionExists(name: string, version: string): Promise<boolean> {
  const metadata = await registryMetadata(name)
  return Boolean(metadata?.versions?.[version])
}

async function packForPublish(rel: string): Promise<{
  name: string
  version: string
  tarballPath: string
  tmp: string
}>
async function packForPublish(
  rel: string,
  versionOverride?: string
): Promise<{
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
    const publishVersion = versionOverride ?? manifest.version

    const publishManifest = {
      ...manifest,
      version: publishVersion,
      exports: stripBunConditions(manifest.exports),
    }
    publishManifest.private = undefined

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

    return { name: manifest.name, version: publishVersion, tarballPath, tmp }
  } catch (error) {
    if (tmp) await rm(tmp, { recursive: true, force: true })
    throw error
  } finally {
    await writeFile(packageJsonPath, originalPackageJson)
  }
}

async function publishPackage(
  rel: string,
  options: Options,
  publishTag: string,
  versionOverride?: string
): Promise<void> {
  const packed = await packForPublish(rel, versionOverride)
  const id = `${packed.name}@${packed.version}`

  try {
    if (options.dryRun) {
      console.log(`DRY_RUN  ${id} --tag ${publishTag}`)
      return
    }

    if (options.channel === 'worktree') {
      const exists = await versionExists(packed.name, packed.version)
      if (exists && !options.force) {
        throw new Error(`${id} already exists in ${REGISTRY}; use --force to replace it`)
      }
      if (exists && options.force) {
        const unpublish = run('npm', ['unpublish', id, '--force', '--registry', REGISTRY])
        if (unpublish.status !== 0 && !isNotPublished(unpublish.out)) {
          throw new Error(`npm unpublish failed for ${id}: ${unpublish.out}`)
        }
      }
    } else {
      const unpublish = run('npm', ['unpublish', packed.name, '--force', '--registry', REGISTRY])
      if (unpublish.status !== 0 && !isNotPublished(unpublish.out)) {
        throw new Error(`npm unpublish failed for ${packed.name}: ${unpublish.out}`)
      }
    }

    const publish = run('npm', [
      'publish',
      packed.tarballPath,
      '--ignore-scripts',
      '--registry',
      REGISTRY,
      '--tag',
      publishTag,
    ])
    if (publish.status !== 0) {
      throw new Error(`npm publish failed for ${id}: ${publish.out}`)
    }

    const view = run('npm', ['view', id, 'version', '--registry', REGISTRY])
    if (view.status !== 0 || view.out.trim() !== packed.version) {
      throw new Error(`npm view failed after publishing ${id}: ${view.out}`)
    }

    console.log(`PUBLISHED  ${id} --tag ${publishTag}`)
  } finally {
    await rm(packed.tmp, { recursive: true, force: true })
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const publishTag = resolveTag(options)
  const ping = run('npm', ['ping', '--registry', REGISTRY])
  if (ping.status !== 0) {
    throw new Error(`Verdaccio is not reachable at ${REGISTRY}: ${ping.out}`)
  }

  const firstManifest = (await Bun.file(join(ROOT, PACKAGES[0], 'package.json')).json()) as Manifest
  if (!firstManifest.version) {
    throw new Error(`${PACKAGES[0]}/package.json must include version`)
  }
  const versionOverride =
    options.version ??
    (options.channel === 'worktree'
      ? timestampVersion(firstManifest.version, 'worktree')
      : undefined)
  if (versionOverride && !isSemver(versionOverride)) {
    throw new Error(`Publish version must be valid semver: ${versionOverride}`)
  }

  const mode = options.dryRun ? 'Dry-run publishing' : 'Publishing'
  const versionLabel = versionOverride ?? 'source manifest versions'
  console.log(
    `${mode} ${PACKAGES.length} ACP package(s) as ${versionLabel} --tag ${publishTag} to ${REGISTRY}`
  )
  for (const rel of PACKAGES) {
    await publishPackage(rel, options, publishTag, versionOverride)
  }
}

if (import.meta.main) {
  await main()
}
