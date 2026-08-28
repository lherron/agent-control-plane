import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// scripts/lib/ -> repo root
const ROOT = resolve(import.meta.dir, '..', '..')
// Destructure rather than index/property access: consumers span tsconfigs that
// require bracket access on index signatures (noPropertyAccessFromIndexSignature)
// and biome configs that forbid it (useLiteralKeys); destructuring satisfies both.
const { VERDACCIO_REGISTRY } = process.env
const REGISTRY = VERDACCIO_REGISTRY ?? 'http://mini:4873/'
const LOCK_STALE_MS = 120_000
const LATEST_MAX_RETRIES = 3
const LATEST_RETRY_DELAY_MS = 10_000

/**
 * Tracked manifests always carry this dist-tag specifier for synced packages,
 * never an exact dev-timestamp. The resolved version lives only in bun.lock and
 * node_modules, so a Verdaccio publish never dirties package.json files.
 */
const TAG_SPECIFIER = 'latest'

type Manifest = {
  name?: string
  workspaces?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type RegistryMetadata = {
  versions?: Record<string, unknown>
  // Typed as a concrete field (not Record) so `.latest` is a real-property dot
  // access — valid under both noPropertyAccessFromIndexSignature and useLiteralKeys.
  'dist-tags'?: { latest?: string }
}

/** A set of packages published together as ONE coherent dev-timestamp stream. */
export type CoherenceGroup = {
  label: string
  packages: readonly string[]
}

type LatestEntry = readonly [name: string, version: string]

class IncoherentLatestError extends Error {
  constructor(
    readonly group: CoherenceGroup,
    readonly entries: readonly LatestEntry[]
  ) {
    super(`${group.label} Verdaccio latest set is incoherent: ${formatLatestEntries(entries)}`)
    this.name = 'IncoherentLatestError'
  }
}

type ResolveLatestOptions = {
  readLatest?: (name: string) => Promise<string>
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
  retryDelayMs?: number
  warn?: (message: string) => void
}

export type SyncSpec = {
  /** Human label for log + error text, e.g. 'ASP' or 'WRKQ'. */
  label: string
  /** Lock-dir name under the repo root, e.g. '.asp-sync.lock'. */
  lockName: string
  /** Coherence groups; each must resolve to a single shared latest version. */
  groups: readonly CoherenceGroup[]
  /**
   * Optional manifest discovery override. Defaults to the repo root plus every
   * packages/* member. Repos with apps/* or other workspace roots should pass
   * `workspaceManifestPaths`.
   */
  manifestPaths?: (root: string) => Promise<string[]>
  /** Tmp-dir prefix for the isolated install bunfig (default 'verdaccio-sync-'). */
  tmpPrefix?: string
}

export type VerdaccioFreshness = {
  fresh: boolean
  summary: string
  stale: string[]
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

function formatLatestEntries(entries: readonly LatestEntry[]): string {
  return entries.map(([name, version]) => `${name}@${version}`).join(', ')
}

async function resolveGroupLatest(
  group: CoherenceGroup,
  readLatest: (name: string) => Promise<string>
): Promise<readonly LatestEntry[]> {
  const entries = await Promise.all(
    group.packages.map(async (name) => [name, await readLatest(name)] as const)
  )
  const versions = new Set(entries.map(([, version]) => version))
  if (versions.size !== 1) throw new IncoherentLatestError(group, entries)
  return entries
}

/** Resolve every group to its single coherent latest version; merge into one map. */
export async function resolveLatestWithRetries(
  groups: readonly CoherenceGroup[],
  options: ResolveLatestOptions = {}
): Promise<Map<string, string>> {
  const readLatest = options.readLatest ?? latestVersion
  const sleepFor = options.sleep ?? sleep
  const maxRetries = options.maxRetries ?? LATEST_MAX_RETRIES
  const retryDelayMs = options.retryDelayMs ?? LATEST_RETRY_DELAY_MS
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const latest = new Map<string, string>()
  for (const group of groups) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const entries = await resolveGroupLatest(group, readLatest)
        for (const [name, version] of entries) latest.set(name, version)
        break
      } catch (error) {
        if (!(error instanceof IncoherentLatestError) || attempt >= maxRetries) throw error
        warn(
          `WARN  ${error.message}; retrying ${group.label} latest sweep (${attempt + 1}/${maxRetries}) in ${retryDelayMs}ms`
        )
        await sleepFor(retryDelayMs)
      }
    }
  }
  return latest
}

/** Resolve every group to its single coherent latest version; merge into one map. */
async function resolveLatest(groups: readonly CoherenceGroup[]): Promise<Map<string, string>> {
  return resolveLatestWithRetries(groups)
}

function summaryForGroups(
  groups: readonly CoherenceGroup[],
  versions: ReadonlyMap<string, string>
): string {
  return groups
    .map((group) => {
      const first = group.packages[0]
      return `${group.label}@${first ? versions.get(first) : '?'}`
    })
    .join('  ')
}

async function usedPackageNames(
  discover: (root: string) => Promise<string[]>,
  candidates: ReadonlyMap<string, string>
): Promise<Set<string>> {
  const used = new Set<string>()
  for (const path of await discover(ROOT)) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      if (!dependencies) continue
      for (const name of candidates.keys()) {
        if (dependencies[name] !== undefined) used.add(name)
      }
    }
  }
  return used
}

/** Every concrete package resolution, including nested workspace lock keys. */
export function lockedPackageVersions(lock: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>()
  for (const line of lock.split(/\r?\n/)) {
    const match = line.match(/^\s*("(?:\\.|[^"\\])*"):\s*\[("(?:\\.|[^"\\])*")/)
    if (!match?.[2]) continue
    const resolution = JSON.parse(match[2]) as string
    const separator = resolution.lastIndexOf('@')
    if (separator <= 0 || separator === resolution.length - 1) continue
    const name = resolution.slice(0, separator)
    const version = resolution.slice(separator + 1)
    const found = versions.get(name) ?? new Set<string>()
    found.add(version)
    versions.set(name, found)
  }
  return versions
}

const PACKAGES_BLOCK_OPEN = '\n  "packages": {\n'
const PACKAGES_BLOCK_CLOSE = '\n  }'

type PackagesBlock = { head: string; entries: Map<string, string>; tail: string }

function lockEntryKey(line: string): string | undefined {
  const match = line.match(/^ {4}("(?:\\.|[^"\\])*"):\s*\[/)
  return match?.[1] === undefined ? undefined : (JSON.parse(match[1]) as string)
}

function packagesBlock(lock: string): PackagesBlock {
  const open = lock.indexOf(PACKAGES_BLOCK_OPEN)
  if (open === -1) throw new Error('bun.lock has no "packages" block')
  const bodyStart = open + PACKAGES_BLOCK_OPEN.length
  const bodyEnd = lock.indexOf(PACKAGES_BLOCK_CLOSE, bodyStart)
  if (bodyEnd === -1) throw new Error('bun.lock "packages" block is unterminated')
  const entries = new Map<string, string>()
  for (const line of lock.slice(bodyStart, bodyEnd).split('\n')) {
    if (line.trim() === '') continue
    const key = lockEntryKey(line)
    if (key === undefined) throw new Error(`unrecognized bun.lock resolution line: ${line}`)
    entries.set(key, line)
  }
  return { head: lock.slice(0, bodyStart), entries, tail: lock.slice(bodyEnd + 1) }
}

function splitLockKey(key: string): string[] {
  const parts = key.split('/')
  const segments: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string
    const next = parts[index + 1]
    if (part.startsWith('@') && next !== undefined) {
      segments.push(`${part}/${next}`)
      index += 1
    } else segments.push(part)
  }
  return segments
}

type LockEntryInfo = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  optionalPeers?: string[]
}

function entryDependencies(line: string): string[] {
  const match = line.match(/^ {4}"(?:\\.|[^"\\])*":\s*(\[.*\]),?$/)
  if (!match?.[1]) return []
  const info = (JSON.parse(match[1]) as [string, string?, LockEntryInfo?])[2]
  if (!info) return []
  const optionalPeers = new Set(info.optionalPeers ?? [])
  return [
    ...Object.keys(info.dependencies ?? {}),
    ...Object.keys(info.optionalDependencies ?? {}),
    ...Object.keys(info.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name)),
  ]
}

function resolveDependencyKey(
  from: string,
  dependency: string,
  keys: { has(key: string): boolean }
): string | undefined {
  const segments = splitLockKey(from)
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const candidate = [...segments.slice(0, depth), dependency].join('/')
    if (keys.has(candidate)) return candidate
  }
  return undefined
}

function ownedBySynced(key: string, synced: ReadonlySet<string>): boolean {
  for (const name of synced) {
    if (key === name || key.startsWith(`${name}/`) || key.endsWith(`/${name}`)) return true
    if (key.includes(`/${name}/`)) return true
  }
  return false
}

function rewriteWorkspaceSpecifiers(
  head: string,
  synced: ReadonlySet<string>,
  specifier: string
): string {
  let rewritten = head
  for (const name of synced) {
    const key = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    rewritten = rewritten.replace(
      new RegExp(`^(\\s*${key}: )"[^"]*"`, 'gm'),
      `$1${JSON.stringify(specifier)}`
    )
  }
  return rewritten
}

/** Rebuild `before` with only synced resolutions and their newly-required closure from `after`. */
export function confineLockToSyncedPackages(
  before: string,
  after: string,
  synced: ReadonlySet<string>,
  workspaceSpecifier: string = TAG_SPECIFIER
): string {
  const beforeBlock = packagesBlock(before)
  const afterEntries = packagesBlock(after).entries
  const merged = new Map<string, string>()
  for (const [key, line] of beforeBlock.entries) {
    if (!ownedBySynced(key, synced)) {
      merged.set(key, line)
      continue
    }
    const advanced = afterEntries.get(key)
    if (advanced !== undefined) merged.set(key, advanced)
  }
  const introduced: string[] = []
  for (const [key, line] of afterEntries) {
    if (merged.has(key) || !ownedBySynced(key, synced)) continue
    merged.set(key, line)
    introduced.push(key)
  }
  const pending = [...merged.keys()].filter((key) => ownedBySynced(key, synced))
  while (pending.length > 0) {
    const key = pending.pop() as string
    for (const dependency of entryDependencies(merged.get(key) as string)) {
      if (resolveDependencyKey(key, dependency, merged) !== undefined) continue
      const source = resolveDependencyKey(key, dependency, afterEntries)
      if (source === undefined || merged.has(source)) continue
      merged.set(source, afterEntries.get(source) as string)
      introduced.push(source)
      pending.push(source)
    }
  }
  const head = rewriteWorkspaceSpecifiers(beforeBlock.head, synced, workspaceSpecifier)
  return `${head}${orderedLockEntries(beforeBlock.entries, merged, introduced).join('\n\n')}\n${beforeBlock.tail}`
}

function orderedLockEntries(
  before: ReadonlyMap<string, string>,
  merged: ReadonlyMap<string, string>,
  introduced: readonly string[]
): string[] {
  const keys = [...before.keys()].filter((key) => merged.has(key))
  for (const key of [...introduced].sort()) {
    const at = keys.findIndex((existing) => existing > key)
    keys.splice(at === -1 ? keys.length : at, 0, key)
  }
  return keys.map((key) => merged.get(key) as string)
}

async function lockfileVersions(): Promise<Map<string, Set<string>>> {
  return lockedPackageVersions(await readFile(join(ROOT, 'bun.lock'), 'utf8'))
}

function isSingleVersion(
  versions: ReadonlySet<string> | undefined,
  expected: string | undefined
): boolean {
  return expected !== undefined && versions?.size === 1 && versions.has(expected)
}

function lockedVersionText(versions: ReadonlySet<string> | undefined): string {
  return versions === undefined ? 'missing' : [...versions].sort().join(', ')
}

async function lockfileIsLatest(
  discover: (root: string) => Promise<string[]>,
  latest: ReadonlyMap<string, string>
): Promise<boolean> {
  const used = await usedPackageNames(discover, latest)
  const locked = await lockfileVersions()
  return [...used].every((name) => isSingleVersion(locked.get(name), latest.get(name)))
}

export async function checkVerdaccioFreshness(spec: SyncSpec): Promise<VerdaccioFreshness> {
  const discover = spec.manifestPaths ?? packagesManifestPaths
  const latest = await resolveLatest(spec.groups)
  const used = await usedPackageNames(discover, latest)
  const locked = await lockfileVersions()
  const stale: string[] = []
  for (const name of used) {
    const expected = latest.get(name)
    const actual = locked.get(name)
    if (!isSingleVersion(actual, expected))
      stale.push(`${name}: locked ${lockedVersionText(actual)}, latest ${expected}`)
  }
  return { fresh: stale.length === 0, summary: summaryForGroups(spec.groups, latest), stale }
}

export async function runVerdaccioSyncCli(
  spec: SyncSpec,
  argv: readonly string[] = Bun.argv.slice(2)
): Promise<void> {
  if (argv.includes('--pull')) {
    await syncFromVerdaccio(spec)
    return
  }
  try {
    const freshness = await checkVerdaccioFreshness(spec)
    if (freshness.fresh) console.log(`VERDACCIO_FRESH  ${freshness.summary}`)
    else {
      console.warn(
        `VERDACCIO_STALE  ${freshness.summary}; run just pull-deps\n${freshness.stale.join('\n')}`
      )
    }
  } catch (error) {
    console.warn(
      `VERDACCIO_UNKNOWN  ${spec.label}: ${String(error)}; run just pull-deps explicitly`
    )
  }
}

/** Default discovery: repo root + every packages/* member manifest. */
export async function packagesManifestPaths(root: string): Promise<string[]> {
  const packageDirs = await readdir(join(root, 'packages'), { withFileTypes: true }).catch(() => [])
  const workspacePaths = (
    await Promise.all(
      packageDirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(root, 'packages', entry.name, 'package.json')
          return (await stat(path).catch(() => undefined))?.isFile() ? path : undefined
        })
    )
  ).filter((path): path is string => path !== undefined)
  return [join(root, 'package.json'), ...workspacePaths]
}

/**
 * Discovery honoring the root `workspaces` globs (e.g. apps/*, packages/*), for
 * repos whose synced consumers live outside packages/*. Only the `dir/*` glob
 * form is supported — the only shape these repos use.
 */
export async function workspaceManifestPaths(root: string): Promise<string[]> {
  const paths = new Set<string>([join(root, 'package.json')])
  const rootRaw = await readFile(join(root, 'package.json'), 'utf8').catch(() => undefined)
  const workspaces = rootRaw ? ((JSON.parse(rootRaw) as Manifest).workspaces ?? []) : []
  for (const pattern of workspaces) {
    if (pattern.endsWith('/*')) {
      // Glob member: every immediate subdirectory is a package.
      const base = join(root, pattern.slice(0, -2))
      const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const path = join(base, entry.name, 'package.json')
        if ((await stat(path).catch(() => undefined))?.isFile()) paths.add(path)
      }
    } else {
      // Bare member: the directory is itself the package (e.g. "examples", "loops").
      const path = join(root, pattern, 'package.json')
      if ((await stat(path).catch(() => undefined))?.isFile()) paths.add(path)
    }
  }
  return [...paths]
}

type RewriteResult = { changed: boolean; used: boolean }

function rewriteDependencySet(
  deps: Record<string, string> | undefined,
  latest: Map<string, string>,
  specifierFor: (name: string, version: string) => string
): RewriteResult {
  if (!deps) return { changed: false, used: false }
  let changed = false
  let used = false
  for (const [name, version] of latest) {
    if (deps[name]) {
      used = true
      const specifier = specifierFor(name, version)
      if (deps[name] !== specifier) {
        deps[name] = specifier
        changed = true
      }
    }
  }
  return { changed, used }
}

/** Rewrite every synced-package specifier across all manifests; quiet no-op when already correct. */
async function rewriteManifests(
  discover: (root: string) => Promise<string[]>,
  latest: Map<string, string>,
  specifierFor: (name: string, version: string) => string
): Promise<RewriteResult> {
  let changed = false
  let used = false
  for (const path of await discover(ROOT)) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
    const results = [
      rewriteDependencySet(manifest.dependencies, latest, specifierFor),
      rewriteDependencySet(manifest.devDependencies, latest, specifierFor),
      rewriteDependencySet(manifest.peerDependencies, latest, specifierFor),
      rewriteDependencySet(manifest.optionalDependencies, latest, specifierFor),
    ]
    if (results.some((result) => result.changed)) {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
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

/**
 * Isolated bunfig for the sync install. Forces minimumReleaseAge = 0 so a
 * just-published dev version is not age-gated by a global ~/.npmrc, while
 * preserving the repo's install linker: a `--config` bunfig fully replaces the
 * repo's, and dropping a `linker = "hoisted"` makes bun relink file: workspace
 * deps and fail with EEXIST.
 */
async function isolatedBunfigContent(): Promise<string> {
  const repoBunfig = await readFile(join(ROOT, 'bunfig.toml'), 'utf8').catch(() => '')
  const linker = repoBunfig.match(/^\s*linker\s*=\s*("[^"]*"|'[^']*')/m)?.[1]
  const lines = ['[install]', 'minimumReleaseAge = 0']
  if (linker) lines.push(`linker = ${linker}`)
  return `${lines.join('\n')}\n`
}

async function bunInstallFromVerdaccio(
  label: string,
  tmpPrefix: string,
  mode: 'resolve' | 'relink' = 'resolve'
): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix))
  try {
    const bunfig = join(tmp, 'bunfig.toml')
    await writeFile(bunfig, await isolatedBunfigContent())
    const flag = mode === 'relink' ? '--frozen-lockfile' : '--no-cache'
    const install = run('bun', ['install', flag, `--config=${bunfig}`])
    if (install.status !== 0) {
      throw new Error(`bun install failed while syncing ${label} packages:\n${install.out}`)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function nestedPackageDirs(discover: (root: string) => Promise<string[]>): Promise<string[]> {
  const dirs: string[] = []
  for (const manifestPath of await discover(ROOT)) {
    const modules = join(dirname(manifestPath), 'node_modules')
    if (modules === join(ROOT, 'node_modules')) continue
    for (const entry of await readdir(modules, { withFileTypes: true }).catch(() => [])) {
      if (!entry.name.startsWith('@')) {
        dirs.push(join(modules, entry.name))
        continue
      }
      const scope = join(modules, entry.name)
      for (const scoped of await readdir(scope, { withFileTypes: true }).catch(() => [])) {
        dirs.push(join(scope, scoped.name))
      }
    }
  }
  return dirs
}

async function pruneNestedPackageDirs(
  discover: (root: string) => Promise<string[]>,
  before: readonly string[]
): Promise<void> {
  const known = new Set(before)
  for (const dir of await nestedPackageDirs(discover)) {
    if (!known.has(dir)) await rm(dir, { recursive: true, force: true })
  }
}

/** Resolve once, splice only the owned package closure, then relink from the frozen result. */
export async function installConfinedPackages(options: {
  label: string
  tmpPrefix: string
  synced: ReadonlySet<string>
  lockBefore: string
  discover?: (root: string) => Promise<string[]>
  workspaceSpecifier?: string
  beforeRelink?: () => Promise<void>
}): Promise<void> {
  const discover = options.discover ?? packagesManifestPaths
  const lockPath = join(ROOT, 'bun.lock')
  const nestedBefore = await nestedPackageDirs(discover)
  await bunInstallFromVerdaccio(options.label, options.tmpPrefix)
  await options.beforeRelink?.()
  await writeFile(
    lockPath,
    confineLockToSyncedPackages(
      options.lockBefore,
      await readFile(lockPath, 'utf8'),
      options.synced,
      options.workspaceSpecifier ?? TAG_SPECIFIER
    )
  )
  await pruneNestedPackageDirs(discover, nestedBefore)
  await bunInstallFromVerdaccio(options.label, options.tmpPrefix, 'relink')
}

/**
 * A sync leaves its bun.lock change UNCOMMITTED and says so. The repo that
 * dirtied it is not necessarily the repo that ran the sync — a producer's
 * `just install` drives this in each consumer — so the commit belongs to
 * whoever owns this checkout, on their next landing (T-07629).
 */
function announceDirtyLockfile(label: string): void {
  const status = run('git', ['status', '--porcelain', '--', 'bun.lock'])
  if (status.status !== 0 || status.out.trim() === '') return
  console.log(
    `LOCK_DIRTY  bun.lock (${label} sync) — uncommitted; commit it with your next landing`
  )
}

export async function commitSyncedLockfile(groups: readonly CoherenceGroup[]): Promise<void> {
  const locked = await lockfileVersions()
  announceDirtyLockfile(
    `dependency ${summaryForGroups(groups, new Map([...locked].map(([name, versions]) => [name, [...versions][0] ?? '?'])))}`
  )
}

/**
 * Sync a set of locally-published Verdaccio dev packages into this repo.
 *
 * Tracked manifests permanently declare synced packages as "latest" (dist-tag
 * specifier); the resolved dev-timestamp lives only in bun.lock + node_modules.
 * When Verdaccio's coherent latest differs from what's installed, we advance
 * deterministically: temporarily pin the exact verified versions, install, then
 * restore the tag specifier and reinstall so bun.lock records "latest" again.
 * (bun won't re-resolve a tag already satisfied by the lock, and `bun update`
 * both rewrites package.json and re-resolves tags outside our coherence check —
 * hence the pin/restore dance.) The resulting lockfile-only change is left
 * uncommitted and announced. Serialized by a repo-root lock dir so concurrent
 * syncs of the same stream don't collide.
 *
 * Steady state (installed == latest, manifests already tagged) does zero
 * installs and zero writes. A republish between resolveLatest and the reconcile
 * install can make verifyInstalled fail loudly; rerunning the sync converges.
 */
export async function syncFromVerdaccio(spec: SyncSpec): Promise<void> {
  const discover = spec.manifestPaths ?? packagesManifestPaths
  const tmpPrefix = spec.tmpPrefix ?? 'verdaccio-sync-'
  await withLock(join(ROOT, spec.lockName), async () => {
    const latest = await resolveLatest(spec.groups)
    const summary = summaryForGroups(spec.groups, latest)

    // Enforce the stable tag specifier (also migrates any stray exact pins).
    const normalized = await rewriteManifests(discover, latest, () => TAG_SPECIFIER)
    if (!normalized.used) {
      console.log(`${spec.label}_SYNC  ${summary} (no refs)`)
      return
    }

    const stale = !(await installedAreLatest(latest)) || !(await lockfileIsLatest(discover, latest))
    if (stale || normalized.changed) {
      const lockBefore = await readFile(join(ROOT, 'bun.lock'), 'utf8')
      await rewriteManifests(discover, latest, (_name, version) => version)
      await installConfinedPackages({
        label: spec.label,
        tmpPrefix,
        synced: new Set(latest.keys()),
        lockBefore,
        discover,
        beforeRelink: async () => {
          await rewriteManifests(discover, latest, () => TAG_SPECIFIER)
        },
      })
    }
    await verifyInstalled(latest, spec.label)
    // Only report churn this run produced — a bun.lock dirtied by someone
    // else's in-flight work is theirs to speak for.
    if (stale || normalized.changed) announceDirtyLockfile(spec.label)
    console.log(`${spec.label}_SYNC  ${summary}`)
  })
}
