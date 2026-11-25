/**
 * Tracked manifests always carry this dist-tag specifier for synced packages,
 * never an exact dev-timestamp. The resolved version lives only in bun.lock and
 * node_modules, so a Verdaccio publish never dirties package.json files.
 */
export const TAG_SPECIFIER = 'latest'

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

export type PackagesBlock = { head: string; entries: Map<string, string>; tail: string }

function lockEntryKey(line: string): string | undefined {
  const match = line.match(/^ {4}("(?:\\.|[^"\\])*"):\s*\[/)
  return match?.[1] === undefined ? undefined : (JSON.parse(match[1]) as string)
}

export function packagesBlock(lock: string): PackagesBlock {
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

/** Dependency NAME plus the requirement the entry records for it. */
export function entryDependencySpecs(line: string): Array<[string, string]> {
  const match = line.match(/^ {4}"(?:\\.|[^"\\])*":\s*(\[.*\]),?$/)
  if (!match?.[1]) return []
  const info = (JSON.parse(match[1]) as [string, string?, LockEntryInfo?])[2]
  if (!info) return []
  const optionalPeers = new Set(info.optionalPeers ?? [])
  const specs: Array<[string, string]> = []
  for (const [name, requirement] of Object.entries(info.dependencies ?? {})) {
    specs.push([name, requirement])
  }
  for (const [name, requirement] of Object.entries(info.optionalDependencies ?? {})) {
    specs.push([name, requirement])
  }
  for (const [name, requirement] of Object.entries(info.peerDependencies ?? {})) {
    if (!optionalPeers.has(name)) specs.push([name, requirement])
  }
  return specs
}

/** The version a lock entry resolves, e.g. `["cap-rpc@1.2.3", …]` -> `1.2.3`. */
export function entryResolvedVersion(line: string): string | undefined {
  const match = line.match(/\[\s*("(?:\\.|[^"\\])*")/)
  if (!match?.[1]) return undefined
  const resolution = JSON.parse(match[1]) as string
  const separator = resolution.lastIndexOf('@')
  return separator <= 0 ? undefined : resolution.slice(separator + 1)
}

/**
 * True when `requirement` names ONE exact version that `line` does not resolve.
 * Ranges are left alone: only an exact pin lets us say the entry is wrong
 * without implementing semver.
 */
function entryContradictsRequirement(line: string, requirement: string): boolean {
  if (!/^\d[\w.+-]*$/.test(requirement)) return false
  const resolved = entryResolvedVersion(line)
  return resolved !== undefined && resolved !== requirement
}

export function resolveDependencyKey(
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

/**
 * A specifier per synced package. A set advance pins its own members to its own
 * tuple version, so two sets advanced in one install need two specifiers.
 */
export type WorkspaceSpecifier = string | ((name: string) => string)

function specifierFor(specifier: WorkspaceSpecifier, name: string): string {
  return typeof specifier === 'function' ? specifier(name) : specifier
}

function rewriteWorkspaceSpecifiers(
  head: string,
  synced: ReadonlySet<string>,
  specifier: WorkspaceSpecifier
): string {
  let rewritten = head
  for (const name of synced) {
    const key = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    rewritten = rewritten.replace(
      new RegExp(`^(\\s*${key}: )"[^"]*"`, 'gm'),
      `$1${JSON.stringify(specifierFor(specifier, name))}`
    )
  }
  return rewritten
}

/**
 * Packages the lock is merely CATCHING UP to: not part of the synced set, but
 * every version this install selected for them is one the tracked manifests
 * already declare. Copying the stale `before` entry forward instead would leave
 * a lock that disagrees with its own manifests, which a frozen relink rejects.
 */
/** The package a lock entry resolves, e.g. `["@wrkq/client@1.2.3", …]` -> `@wrkq/client`. */
export function entryPackageName(line: string): string | undefined {
  const match = line.match(/\[\s*("(?:\\.|[^"\\])*")/)
  if (!match?.[1]) return undefined
  const resolution = JSON.parse(match[1]) as string
  const separator = resolution.lastIndexOf('@')
  return separator <= 0 ? resolution : resolution.slice(0, separator)
}

function catchingUpPackages(
  after: string,
  synced: ReadonlySet<string>,
  declared: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const catchUp = new Set<string>()
  if (declared.size === 0) return catchUp
  for (const [name, versions] of lockedPackageVersions(after)) {
    if (synced.has(name) || versions.size === 0) continue
    const declaredVersions = declared.get(name)
    if (declaredVersions === undefined) continue
    if ([...versions].every((version) => declaredVersions.has(version))) catchUp.add(name)
  }
  return catchUp
}

/** Rebuild `before` with only synced resolutions and their newly-required closure from `after`. */
export function confineLockToSyncedPackages(
  before: string,
  after: string,
  synced: ReadonlySet<string>,
  workspaceSpecifier: WorkspaceSpecifier = TAG_SPECIFIER,
  declared: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): string {
  const beforeBlock = packagesBlock(before)
  const afterBlock = packagesBlock(after)
  const afterEntries = afterBlock.entries
  const catchUp = catchingUpPackages(after, synced, declared)
  const adopted = new Set([...synced, ...catchUp])
  const merged = new Map<string, string>()
  for (const [key, line] of beforeBlock.entries) {
    if (!ownedBySynced(key, adopted)) {
      // A resolution the fresh install dropped, for a package the tracked
      // manifests no longer declare, is an orphan. Copying it forward would
      // resurrect a dependency nothing asks for and desync the lock again.
      const name = entryPackageName(line)
      if (
        declared.size > 0 &&
        !afterEntries.has(key) &&
        name !== undefined &&
        !declared.has(name)
      ) {
        continue
      }
      merged.set(key, line)
      continue
    }
    const advanced = afterEntries.get(key)
    if (advanced !== undefined) merged.set(key, advanced)
  }
  const introduced: string[] = []
  for (const [key, line] of afterEntries) {
    if (merged.has(key) || !ownedBySynced(key, adopted)) continue
    merged.set(key, line)
    introduced.push(key)
  }
  const pending = [...merged.keys()].filter((key) => ownedBySynced(key, adopted))
  while (pending.length > 0) {
    const key = pending.pop() as string
    for (const [dependency, requirement] of entryDependencySpecs(merged.get(key) as string)) {
      // A carried-over entry can bear the right NAME at the wrong version, which
      // silently satisfies the closure and leaves the lock unable to install.
      const resolved = resolveDependencyKey(key, dependency, merged)
      if (
        resolved !== undefined &&
        !entryContradictsRequirement(merged.get(resolved) as string, requirement)
      ) {
        continue
      }
      const source = resolveDependencyKey(key, dependency, afterEntries)
      if (source === undefined) continue
      const advanced = afterEntries.get(source) as string
      if (merged.get(source) === advanced) continue
      if (!merged.has(source)) introduced.push(source)
      merged.set(source, advanced)
      pending.push(source)
    }
  }
  // A resolve pass can still list a subtree the advance orphaned (an old member
  // dependency and everything under it); the frozen relink prunes it and then
  // refuses the lock. Keep only what the workspaces actually reach.
  const reachable = reachableLockKeys(after, merged)
  for (const key of [...merged.keys()]) if (!reachable.has(key)) merged.delete(key)
  // The head is a projection of the tracked manifests, not a resolution: it is
  // the only place an ADDED or REMOVED declaration shows up, so it has to come
  // from the fresh install. Entries below still come from `before` for anything
  // outside the adopted set, which is what confinement actually protects.
  const head = rewriteWorkspaceSpecifiers(afterBlock.head, synced, workspaceSpecifier)
  return `${head}${orderedLockEntries(beforeBlock.entries, merged, introduced).join('\n\n')}\n${beforeBlock.tail}`
}

export type LockWorkspace = {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export function lockWorkspaces(lock: string): Record<string, LockWorkspace> {
  const parsed = JSON.parse(lock.replace(/,(\s*[}\]])/g, '$1')) as {
    workspaces?: Record<string, LockWorkspace>
  }
  return parsed.workspaces ?? {}
}

/** Keys of `entries` reachable from `lock`'s workspace declarations and workspace entries. */
export function reachableLockKeys(lock: string, entries: ReadonlyMap<string, string>): Set<string> {
  const queue: string[] = []
  for (const [from, workspace] of Object.entries(lockWorkspaces(lock))) {
    for (const group of [
      workspace.dependencies,
      workspace.devDependencies,
      workspace.optionalDependencies,
      workspace.peerDependencies,
    ]) {
      for (const dependency of Object.keys(group ?? {})) {
        const key = resolveDependencyKey(
          from === '' ? '' : (workspace.name ?? from),
          dependency,
          entries
        )
        if (key !== undefined) queue.push(key)
      }
    }
  }
  for (const [key, line] of entries) {
    if (entryResolvedVersion(line)?.startsWith('workspace:')) queue.push(key)
  }
  const reached = new Set<string>()
  while (queue.length > 0) {
    const key = queue.pop() as string
    if (reached.has(key)) continue
    reached.add(key)
    for (const [dependency] of entryDependencySpecs(entries.get(key) as string)) {
      const target = resolveDependencyKey(key, dependency, entries)
      if (target !== undefined) queue.push(target)
    }
  }
  return reached
}

function orderedLockEntries(
  before: ReadonlyMap<string, string>,
  merged: ReadonlyMap<string, string>,
  introduced: readonly string[]
): string[] {
  const keys = [...before.keys()].filter((key) => merged.has(key))
  for (const key of [...introduced].filter((key) => merged.has(key)).sort()) {
    const at = keys.findIndex((existing) => existing > key)
    keys.splice(at === -1 ? keys.length : at, 0, key)
  }
  return keys.map((key) => merged.get(key) as string)
}
