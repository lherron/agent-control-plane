import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// scripts/lib/ -> repo root
const ROOT = resolve(import.meta.dir, '..', '..')
const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://127.0.0.1:4873/'
const LOCK_STALE_MS = 120_000

type Manifest = {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type RegistryMetadata = {
  versions?: Record<string, unknown>
  'dist-tags'?: Record<string, string>
}

/** A set of packages published together as ONE coherent dev-timestamp stream. */
export type CoherenceGroup = {
  label: string
  packages: readonly string[]
}

export type SyncSpec = {
  /** Human label for log + error text, e.g. 'ASP' or 'WRKQ'. */
  label: string
  /** Lock-dir name under the repo root, e.g. '.asp-sync.lock'. */
  lockName: string
  /** Coherence groups; each must resolve to a single shared latest version. */
  groups: readonly CoherenceGroup[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function run(cmd: string, args: string[]): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  return { status: result.status ?? -1, out: `${result.stdout || ''}${result.stderr || ''}` }
}

async function withLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      await mkdir(lockDir)
      await writeFile(join(lockDir, 'pid'), `${process.pid}\n`)
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      const lockStat = await stat(lockDir).catch(() => undefined)
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true })
        continue
      }
      await sleep(250)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

async function latestVersion(name: string): Promise<string> {
  const url = `${REGISTRY.replace(/\/$/, '')}/${encodeURIComponent(name)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to read ${name} from Verdaccio (${response.status})`)
  }
  const metadata = (await response.json()) as RegistryMetadata
  const latest = metadata['dist-tags']?.latest
  if (!latest || !metadata.versions?.[latest]) {
    throw new Error(`Verdaccio metadata for ${name} has no valid latest dist-tag`)
  }
  return latest
}

/** Resolve every group to its single coherent latest version; merge into one map. */
async function resolveLatest(groups: readonly CoherenceGroup[]): Promise<Map<string, string>> {
  const latest = new Map<string, string>()
  for (const group of groups) {
    const entries = await Promise.all(
      group.packages.map(async (name) => [name, await latestVersion(name)] as const)
    )
    const versions = new Set(entries.map(([, version]) => version))
    if (versions.size !== 1) {
      throw new Error(
        `${group.label} Verdaccio latest set is incoherent: ${entries
          .map(([name, version]) => `${name}@${version}`)
          .join(', ')}`
      )
    }
    for (const [name, version] of entries) latest.set(name, version)
  }
  return latest
}

/**
 * Manifests that may pin synced packages. Includes the ROOT package.json: it is
 * where the ASP/HRC deps are pinned, and scanning only packages/* left those
 * root pins frozen so the sync could never advance them — bun install kept
 * reinstalling the stale version and verify failed every run. (looper fix, T-05379)
 */
async function packageManifestPaths(): Promise<string[]> {
  const packageDirs = await readdir(join(ROOT, 'packages'), { withFileTypes: true })
  const workspacePaths = (
    await Promise.all(
      packageDirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(ROOT, 'packages', entry.name, 'package.json')
          return (await stat(path).catch(() => undefined))?.isFile() ? path : undefined
        })
    )
  ).filter((path): path is string => path !== undefined)
  return [join(ROOT, 'package.json'), ...workspacePaths]
}

type SyncResult = { changed: boolean; used: boolean }

function syncDependencySet(
  deps: Record<string, string> | undefined,
  latest: Map<string, string>
): SyncResult {
  if (!deps) return { changed: false, used: false }
  let changed = false
  let used = false
  for (const [name, version] of latest) {
    if (deps[name]) {
      used = true
      if (deps[name] !== version) {
        deps[name] = version
        changed = true
      }
    }
  }
  return { changed, used }
}

async function syncManifests(latest: Map<string, string>): Promise<SyncResult> {
  let changed = false
  let used = false
  for (const path of await packageManifestPaths()) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
    const results = [
      syncDependencySet(manifest.dependencies, latest),
      syncDependencySet(manifest.devDependencies, latest),
      syncDependencySet(manifest.peerDependencies, latest),
      syncDependencySet(manifest.optionalDependencies, latest),
    ]
    if (results.some((result) => result.changed)) {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log(`UPDATED  ${manifest.name ?? path}`)
      changed = true
    }
    used ||= results.some((result) => result.used)
  }
  return { changed, used }
}

async function installedVersion(name: string): Promise<string | undefined> {
  const raw = await readFile(join(ROOT, 'node_modules', name, 'package.json'), 'utf8').catch(
    () => undefined
  )
  if (!raw) return undefined
  return (JSON.parse(raw) as { version?: string }).version
}

async function installedAreLatest(latest: Map<string, string>): Promise<boolean> {
  for (const [name, version] of latest) {
    const installed = await installedVersion(name)
    if (installed === undefined) continue
    if (installed !== version) return false
  }
  return true
}

async function verifyInstalled(latest: Map<string, string>, label: string): Promise<void> {
  const stale: string[] = []
  for (const [name, version] of latest) {
    const installed = await installedVersion(name)
    if (installed === undefined) continue
    if (installed !== version) stale.push(`${name}: installed ${installed}, latest ${version}`)
  }
  if (stale.length > 0) {
    throw new Error(`${label} dependency sync failed:\n${stale.join('\n')}`)
  }
}

async function bunInstallFromVerdaccio(label: string): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'acp-verdaccio-sync-'))
  try {
    const bunfig = join(tmp, 'bunfig.toml')
    await writeFile(bunfig, '[install]\nminimumReleaseAge = 0\n')
    // --no-cache bypasses bun's manifest cache so we always see Verdaccio's
    // current dist-tags. Without it, a freshly-published dev version can
    // "fail to resolve" until the cache TTL expires.
    const install = run('bun', ['install', '--no-cache', `--config=${bunfig}`])
    if (install.status !== 0) {
      throw new Error(`bun install failed while syncing ${label} packages:\n${install.out}`)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Sync a set of locally-published Verdaccio dev packages into this repo: bump
 * every manifest pin (root + packages/*) to the latest coherent dev-timestamp,
 * reinstall when anything moved, and verify node_modules matches. Serialized by
 * a repo-root lock dir so concurrent syncs don't collide.
 */
export async function syncFromVerdaccio(spec: SyncSpec): Promise<void> {
  await withLock(join(ROOT, spec.lockName), async () => {
    const latest = await resolveLatest(spec.groups)
    const summary = spec.groups
      .map((group) => `${group.label}@${latest.get(group.packages[0])}`)
      .join('  ')

    const { changed, used } = await syncManifests(latest)
    if (!used) {
      console.log(`${spec.label}_SYNC  ${summary} (no refs)`)
      return
    }

    if (changed || !(await installedAreLatest(latest))) {
      await bunInstallFromVerdaccio(spec.label)
    }
    await verifyInstalled(latest, spec.label)
    console.log(`${spec.label}_SYNC  ${summary}`)
  })
}
