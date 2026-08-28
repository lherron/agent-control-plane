import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  EXPECTED_CONSUMER_PRODUCERS,
  type PraesidiumBuild,
  type ProducerSetName,
  evaluateConsumerDeployment,
  isPraesidiumBuild,
  readConsumerDeploymentInputs,
} from '../packages/acp-server/src/deployment-coherence.js'
import {
  installConfinedPackages,
  lockedPackageVersions,
  packagesManifestPaths,
} from './lib/verdaccio-sync.js'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = process.env['VERDACCIO_REGISTRY'] ?? 'http://mini:4873/'
const TABLE_PATH = 'packages/acp-server/src/deployment-coherence.ts'
const ANCHORS: Record<ProducerSetName, string> = { asp: 'agent-spaces', hrc: 'hrc-core' }

type PublishedManifest = {
  name?: string
  version?: string
  praesidiumBuild?: unknown
}

type RegistryMetadata = {
  versions?: Record<string, PublishedManifest>
  'dist-tags'?: { latest?: string }
}

function run(command: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  return {
    status: result.status ?? -1,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

async function registryMetadata(name: string): Promise<RegistryMetadata> {
  const url = `${REGISTRY.replace(/\/$/, '')}/${encodeURIComponent(name)}`
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
  if (!response.ok) throw new Error(`${name}: registry metadata returned ${response.status}`)
  return (await response.json()) as RegistryMetadata
}

export async function resolvePublishedManifest(
  name: string,
  requestedVersion: string
): Promise<{ version: string; manifest: PublishedManifest; build: PraesidiumBuild }> {
  const metadata = await registryMetadata(name)
  const version = requestedVersion === 'latest' ? metadata['dist-tags']?.latest : requestedVersion
  if (version === undefined) throw new Error(`${name}: registry has no latest dist-tag`)
  const manifest = metadata.versions?.[version]
  if (manifest === undefined) throw new Error(`${name}@${version}: registry version is missing`)
  if (!isPraesidiumBuild(manifest.praesidiumBuild)) {
    throw new Error(`${name}@${version}: published manifest has no praesidiumBuild tuple`)
  }
  return { version, manifest, build: manifest.praesidiumBuild }
}

export async function producerMembership(): Promise<Record<ProducerSetName, string[]>> {
  const inputs = await readConsumerDeploymentInputs(ROOT)
  const result: Record<ProducerSetName, string[]> = { asp: [], hrc: [] }
  for (const entry of inputs.installed) {
    const setName = entry.praesidiumBuild?.setName
    if (setName === 'asp' || setName === 'hrc') result[setName].push(entry.name)
  }
  result.asp = [...new Set(result.asp)].sort()
  result.hrc = [...new Set(result.hrc)].sort()
  return result
}

async function assertCompletePublishedSet(
  setName: ProducerSetName,
  version: string,
  anchorBuild: PraesidiumBuild,
  members: readonly string[]
): Promise<void> {
  const failures: string[] = []
  await Promise.all(
    members.map(async (name) => {
      try {
        const published = await resolvePublishedManifest(name, version)
        const build = published.build
        if (
          published.manifest.version !== version ||
          build.setName !== setName ||
          build.setVersion !== version ||
          build.repository !== anchorBuild.repository ||
          build.canonicalRemote !== anchorBuild.canonicalRemote ||
          build.sourceCommit !== anchorBuild.sourceCommit
        ) {
          failures.push(`${name}@${version}: published tuple disagrees with anchor`)
        }
      } catch (error) {
        failures.push(String(error))
      }
    })
  )
  if (failures.length > 0) {
    throw new Error(`partial or incoherent ${setName} producer set:\n${failures.sort().join('\n')}`)
  }
}

function parseArguments(argv: readonly string[]): {
  setName: ProducerSetName
  version: string
  dryRun: boolean
} {
  const values = new Map<string, string>()
  for (const arg of argv) {
    const normalized = arg.startsWith('--') ? arg.slice(2) : arg
    const [key, ...rest] = normalized.split('=')
    if (key && rest.length > 0) values.set(key, rest.join('='))
  }
  const setName = values.get('set')
  const version = values.get('version')
  if ((setName !== 'asp' && setName !== 'hrc') || version === undefined) {
    throw new Error(
      'usage: advance-producers set=<asp|hrc> version=<setVersion|latest> [--dry-run]'
    )
  }
  return { setName, version, dryRun: argv.includes('--dry-run') }
}

function assertCleanTrackedTree(): void {
  const status = run('git', ['status', '--porcelain', '--untracked-files=no'])
  if (status.status !== 0) throw new Error(`git status failed:\n${status.output}`)
  if (status.output.trim() !== '') {
    throw new Error(`advance-producers refuses a dirty tracked tree:\n${status.output.trim()}`)
  }
}

async function rewriteProducerFiles(
  setName: ProducerSetName,
  oldVersion: string,
  version: string,
  oldCommit: string,
  sourceCommit: string,
  members: ReadonlySet<string>
): Promise<string[]> {
  const changed: string[] = []
  const tableFile = resolve(ROOT, TABLE_PATH)
  const beforeTable = await readFile(tableFile, 'utf8')
  const afterTable = beforeTable
    .replace(`setVersion: '${oldVersion}'`, `setVersion: '${version}'`)
    .replace(`sourceCommit: '${oldCommit}'`, `sourceCommit: '${sourceCommit}'`)
  if (afterTable === beforeTable)
    throw new Error(`failed to rewrite ${setName} producer table entry`)
  await writeFile(tableFile, afterTable)
  changed.push(TABLE_PATH)

  for (const absolutePath of await packagesManifestPaths(ROOT)) {
    const before = await readFile(absolutePath, 'utf8')
    const manifest = JSON.parse(before) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      overrides?: Record<string, string>
    }
    let touched = false
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      for (const name of members) {
        if (dependencies?.[name] !== undefined && dependencies[name] !== version) {
          dependencies[name] = version
          touched = true
        }
      }
    }
    if (absolutePath === resolve(ROOT, 'package.json')) {
      manifest.overrides ??= {}
      for (const name of members) {
        if (manifest.overrides[name] !== version) {
          manifest.overrides[name] = version
          touched = true
        }
      }
    }
    if (touched) {
      await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`)
      changed.push(absolutePath.slice(ROOT.length + 1))
    }
  }
  return changed
}

function equalVersionSets(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined) {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort())
}

function assertUnrelatedLockSelectionsUnchanged(
  before: string,
  after: string,
  members: ReadonlySet<string>
): void {
  const beforeVersions = lockedPackageVersions(before)
  const afterVersions = lockedPackageVersions(after)
  const moved: string[] = []
  for (const [name, versions] of beforeVersions) {
    if (!members.has(name) && !equalVersionSets(versions, afterVersions.get(name))) moved.push(name)
  }
  if (moved.length > 0) {
    throw new Error(`producer advance moved unrelated lock selections: ${moved.sort().join(', ')}`)
  }
}

async function restoreSnapshots(snapshots: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, content] of snapshots) await writeFile(resolve(ROOT, path), content)
}

export async function advanceProducers(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const { setName, version: requestedVersion, dryRun } = parseArguments(argv)
  assertCleanTrackedTree()
  const producer = EXPECTED_CONSUMER_PRODUCERS.find((entry) => entry.setName === setName)
  if (producer === undefined) throw new Error(`unknown producer set ${setName}`)
  const membership = await producerMembership()
  for (const name of ['asp', 'hrc'] as const) {
    console.log(`PRODUCER_MEMBERS ${name} ${membership[name].join(',')}`)
  }
  const anchor = await resolvePublishedManifest(ANCHORS[setName], requestedVersion)
  if (
    anchor.build.setName !== setName ||
    anchor.build.repository !== producer.repository ||
    anchor.build.canonicalRemote !== producer.canonicalRemote
  ) {
    throw new Error(`${ANCHORS[setName]}@${anchor.version}: wrong-repository producer tuple`)
  }
  await assertCompletePublishedSet(setName, anchor.version, anchor.build, membership[setName])
  console.log(
    `PRODUCER_PLAN ${setName} ${producer.setVersion}@${producer.sourceCommit} -> ${anchor.version}@${anchor.build.sourceCommit}; members=${membership[setName].join(',')}`
  )
  if (dryRun) {
    console.log('PRODUCER_DRY_RUN no files written')
    return
  }
  if (
    anchor.version === producer.setVersion &&
    anchor.build.sourceCommit === producer.sourceCommit
  ) {
    console.log(
      `PRODUCER_ADVANCED ${setName} ${producer.setVersion} -> ${anchor.version} (${anchor.build.sourceCommit}) — no change`
    )
    return
  }

  const manifestPaths = (await packagesManifestPaths(ROOT)).map((path) =>
    path.slice(ROOT.length + 1)
  )
  const snapshotPaths = new Set(['bun.lock', TABLE_PATH, ...manifestPaths])
  const snapshots = new Map<string, string>()
  for (const path of snapshotPaths) snapshots.set(path, await readFile(resolve(ROOT, path), 'utf8'))
  const lockBeforeAdvance = snapshots.get('bun.lock') as string
  try {
    let members = new Set(membership[setName])
    await rewriteProducerFiles(
      setName,
      producer.setVersion,
      anchor.version,
      producer.sourceCommit,
      anchor.build.sourceCommit,
      members
    )
    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const lockBeforeIteration = await readFile(resolve(ROOT, 'bun.lock'), 'utf8')
      await installConfinedPackages({
        label: setName.toUpperCase(),
        tmpPrefix: `advance-${setName}-`,
        synced: members,
        lockBefore: lockBeforeIteration,
        workspaceSpecifier: anchor.version,
      })
      const nextMembership = await producerMembership()
      const added = nextMembership[setName].filter((name) => !members.has(name))
      if (added.length === 0) break
      if (iteration === 3) {
        throw new Error(`producer membership did not reach fixpoint: ${added.join(', ')}`)
      }
      members = new Set([...members, ...added])
      const rootPath = resolve(ROOT, 'package.json')
      const root = JSON.parse(await readFile(rootPath, 'utf8')) as {
        overrides?: Record<string, string>
      }
      root.overrides ??= {}
      for (const name of added) root.overrides[name] = anchor.version
      await writeFile(rootPath, `${JSON.stringify(root, null, 2)}\n`)
    }

    const lockAfter = await readFile(resolve(ROOT, 'bun.lock'), 'utf8')
    assertUnrelatedLockSelectionsUnchanged(lockBeforeAdvance, lockAfter, members)
    const changed = run('git', ['diff', '--name-only']).output.trim().split('\n').filter(Boolean)
    const allowed = new Set(['bun.lock', 'package.json', TABLE_PATH, ...manifestPaths])
    const unexpected = changed.filter((path) => !allowed.has(path))
    if (unexpected.length > 0)
      throw new Error(`producer advance touched unexpected files: ${unexpected.join(', ')}`)
    const report = evaluateConsumerDeployment(await readConsumerDeploymentInputs(ROOT))
    if (!report.ok) throw new Error(`post-advance coherence failed:\n${report.findings.join('\n')}`)
    console.log(
      `PRODUCER_ADVANCED ${setName} ${producer.setVersion} -> ${anchor.version} (${anchor.build.sourceCommit}) — review and commit with your landing`
    )
  } catch (error) {
    await restoreSnapshots(snapshots)
    throw error
  }
}

if (import.meta.main) await advanceProducers()
