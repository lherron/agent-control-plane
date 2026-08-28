import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export const PRAESIDIUM_BUILD_FIELDS = [
  'schema',
  'repository',
  'canonicalRemote',
  'sourceCommit',
  'setName',
  'setVersion',
  'builtAt',
] as const

export const PRAESIDIUM_BUILD_IDENTITY_FIELDS = [
  'schema',
  'repository',
  'sourceCommit',
  'setName',
] as const

export type PraesidiumBuild = Readonly<{
  schema: 1
  repository: string
  canonicalRemote: string
  sourceCommit: string
  setName: string
  setVersion: string
  builtAt: string
}>

export type ProducerSetName = 'asp' | 'hrc'

export type ExpectedConsumerProducer = Readonly<{
  setName: ProducerSetName
  setVersion: string
  repository: string
  canonicalRemote: string
  sourceCommit: string
}>

/** Producer identity and pin authority. Package membership is deliberately derived. */
export const EXPECTED_CONSUMER_PRODUCERS = [
  {
    setName: 'asp',
    setVersion: '0.1.1-dev.20260825213756',
    repository: 'agent-spaces',
    canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
    sourceCommit: '1e3231ec8d3ccc38c50b9f61fb8deeacc8ef60d4',
  },
  {
    setName: 'hrc',
    setVersion: '0.1.0-dev.20260825215557',
    repository: 'hrc-runtime',
    canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
    sourceCommit: '8f104d1055005d5253e54ef17b0685c82fbc43e8',
  },
] as const satisfies readonly ExpectedConsumerProducer[]

export type InstalledProducerPackage = Readonly<{
  lockKey?: string | undefined
  manifestPath?: string | undefined
  name: string
  version: string
  praesidiumBuild?: PraesidiumBuild | undefined
}>

export type ConsumerLockSelection = Readonly<{
  lockKey: string
  name: string
  version: string
  tarball: string
  integrity: string
}>

export type ConsumerManifest = Readonly<{
  path: string
  dependencies?: Readonly<Record<string, string>> | undefined
  devDependencies?: Readonly<Record<string, string>> | undefined
  overrides?: Readonly<Record<string, string>> | undefined
}>

type RunningStatus = Readonly<{ release?: unknown }>

export type ConsumerDeploymentInputs = Readonly<{
  lockText: string
  installed: readonly InstalledProducerPackage[]
  manifests: readonly ConsumerManifest[]
}>

export type ConsumerDeploymentReport = Readonly<{
  ok: boolean
  expected: typeof EXPECTED_CONSUMER_PRODUCERS
  installed: Readonly<{
    aspBuild?: PraesidiumBuild | undefined
    hrcBuild?: PraesidiumBuild | undefined
  }>
  running?: Readonly<Record<string, unknown>> | undefined
  informational: readonly string[]
  findings: readonly string[]
}>

function buildIdentity(build: PraesidiumBuild): string {
  return JSON.stringify(PRAESIDIUM_BUILD_IDENTITY_FIELDS.map((field) => build[field]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPraesidiumBuild(value: unknown): value is PraesidiumBuild {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  return (
    JSON.stringify(keys) === JSON.stringify([...PRAESIDIUM_BUILD_FIELDS].sort()) &&
    value['schema'] === 1 &&
    typeof value['repository'] === 'string' &&
    typeof value['canonicalRemote'] === 'string' &&
    typeof value['sourceCommit'] === 'string' &&
    typeof value['setName'] === 'string' &&
    typeof value['setVersion'] === 'string' &&
    typeof value['builtAt'] === 'string' &&
    !Number.isNaN(Date.parse(value['builtAt']))
  )
}

export function expectedConsumerProducer(
  setName: string
): (typeof EXPECTED_CONSUMER_PRODUCERS)[number] | undefined {
  return EXPECTED_CONSUMER_PRODUCERS.find((producer) => producer.setName === setName)
}

function expectedBuildFieldsMatch(
  build: PraesidiumBuild,
  expected: ExpectedConsumerProducer
): boolean {
  return (
    build.schema === 1 &&
    build.repository === expected.repository &&
    build.sourceCommit === expected.sourceCommit &&
    build.setName === expected.setName &&
    build.setVersion === expected.setVersion
  )
}

function allLockSelections(lockText: string): ConsumerLockSelection[] {
  const selections: ConsumerLockSelection[] = []
  for (const line of lockText.split(/\r?\n/)) {
    const match = /^\s*"([^"]+)":\s*\[\s*"([^"]+)"(?:,\s*"([^"]+)")?/.exec(line)
    const lockKey = match?.[1]
    const resolution = match?.[2]
    if (lockKey === undefined || resolution === undefined) continue
    const separator = resolution.lastIndexOf('@')
    if (separator <= 0 || separator === resolution.length - 1) continue
    selections.push({
      lockKey,
      name: resolution.slice(0, separator),
      version: resolution.slice(separator + 1),
      tarball: match?.[3] ?? '',
      integrity: /"(sha512-[A-Za-z0-9+/=]+)"\s*\],?\s*$/.exec(line)?.[1] ?? '',
    })
  }
  return selections
}

function expectedTarball(name: string, version: string): string {
  return `http://mini:4873/${name}/-/${name}-${version}.tgz`
}

function runningRelease(status: RunningStatus | undefined): Record<string, unknown> | undefined {
  return isRecord(status?.release) ? status.release : undefined
}

function tupleMembers(
  installed: readonly InstalledProducerPackage[]
): Map<string, PraesidiumBuild> {
  const members = new Map<string, PraesidiumBuild>()
  for (const entry of installed) {
    if (isPraesidiumBuild(entry.praesidiumBuild)) members.set(entry.name, entry.praesidiumBuild)
  }
  return members
}

/** Validate root overrides and every root/workspace direct producer dependency. */
export function producerManifestAgreementFindings(
  manifests: readonly ConsumerManifest[],
  members: ReadonlyMap<string, PraesidiumBuild>
): string[] {
  const findings: string[] = []
  const root = manifests.find((manifest) => manifest.path === 'package.json')
  const overrides = root?.overrides ?? {}
  for (const [name, build] of members) {
    const expected = expectedConsumerProducer(build.setName)
    if (expected !== undefined && overrides[name] !== expected.setVersion) {
      findings.push(
        `${name}: root override ${overrides[name] ?? 'missing'}; expected ${expected.setVersion}`
      )
    }
  }
  for (const name of Object.keys(overrides)) {
    if (name !== '@wrkq/client' && !members.has(name)) {
      findings.push(`${name}: root override does not name a tuple-bearing producer package`)
    }
  }
  for (const manifest of manifests) {
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, specifier] of Object.entries(dependencies ?? {})) {
        const build = members.get(name)
        if (build === undefined) continue
        const expected = expectedConsumerProducer(build.setName)
        if (expected !== undefined && specifier !== expected.setVersion) {
          findings.push(
            `${manifest.path}: ${name} specifier ${specifier}; expected ${expected.setVersion}`
          )
        }
      }
    }
  }
  return findings
}

export function evaluateConsumerDeployment(input: {
  lockText: string
  installed: readonly InstalledProducerPackage[]
  manifests?: readonly ConsumerManifest[] | undefined
  runningStatus?: RunningStatus | undefined
}): ConsumerDeploymentReport {
  const findings = new Set<string>()
  const installedByLockKey = new Map(
    input.installed.map((entry) => [entry.lockKey ?? entry.name, entry])
  )
  const members = tupleMembers(input.installed)
  const installedBuilds: {
    aspBuild?: PraesidiumBuild | undefined
    hrcBuild?: PraesidiumBuild | undefined
  } = {}

  for (const entry of input.installed) {
    const build = entry.praesidiumBuild
    if (!isPraesidiumBuild(build)) continue
    const label = entry.lockKey ?? entry.name
    const expected = expectedConsumerProducer(build.setName)
    if (expected === undefined) {
      findings.add(`${label}: installed manifest names unknown producer set ${build.setName}`)
      continue
    }
    if (entry.version !== expected.setVersion) {
      findings.add(`${label}: installed version ${entry.version}; expected ${expected.setVersion}`)
    }
    if (!expectedBuildFieldsMatch(build, expected)) {
      findings.add(
        `${label}: installed build tuple does not match expected ${expected.setName} set`
      )
    }
    const key = expected.setName === 'asp' ? 'aspBuild' : 'hrcBuild'
    const coherentBuild = installedBuilds[key]
    if (coherentBuild === undefined) installedBuilds[key] = build
    else if (buildIdentity(build) !== buildIdentity(coherentBuild)) {
      findings.add(`${label}: installed build tuple disagrees with ${expected.setName} set`)
    }
  }

  const memberNames = new Set(members.keys())
  const selections = allLockSelections(input.lockText).filter((selection) =>
    memberNames.has(selection.name)
  )
  const selectionKeys = new Set(selections.map((selection) => selection.lockKey))
  for (const entry of input.installed) {
    if (!isPraesidiumBuild(entry.praesidiumBuild)) continue
    const key = entry.lockKey ?? entry.name
    if (!selectionKeys.has(key)) findings.add(`${key}: lock selection is missing`)
  }
  for (const selection of selections) {
    const expected = expectedConsumerProducer(members.get(selection.name)?.setName ?? '')
    if (expected === undefined) continue
    if (selection.version !== expected.setVersion) {
      findings.add(
        `${selection.lockKey}: lock selects ${selection.version}; expected ${expected.setVersion}`
      )
    }
    if (selection.tarball !== expectedTarball(selection.name, selection.version)) {
      findings.add(`${selection.lockKey}: lock tarball is not canonical: ${selection.tarball}`)
    }
    if (selection.integrity.length === 0) {
      findings.add(`${selection.lockKey}: lock integrity is missing`)
    }
    const installed = installedByLockKey.get(selection.lockKey)
    if (installed === undefined) {
      findings.add(`${selection.lockKey}: installed manifest is missing`)
    } else if (installed.name !== selection.name) {
      findings.add(
        `${selection.lockKey}: installed manifest name ${installed.name}; expected ${selection.name}`
      )
    }
  }

  for (const finding of producerManifestAgreementFindings(input.manifests ?? [], members)) {
    findings.add(finding)
  }

  const running = runningRelease(input.runningStatus)
  if (input.runningStatus !== undefined) {
    if (running === undefined) findings.add('running HRC status has no release readback')
    else {
      if (running['mode'] !== 'atomic') findings.add('running HRC release is unmanaged')
      if (running['runningEqualsInstalled'] !== true) {
        findings.add('running HRC release does not equal the installed release')
      }
      const runningAsp = running['aspBuild']
      const runningHrc = running['hrcBuild']
      if (
        installedBuilds.aspBuild !== undefined &&
        (!isPraesidiumBuild(runningAsp) ||
          buildIdentity(runningAsp) !== buildIdentity(installedBuilds.aspBuild))
      ) {
        findings.add('running ASP build identity does not match ACP installed ASP')
      }
      if (
        installedBuilds.hrcBuild !== undefined &&
        (!isPraesidiumBuild(runningHrc) ||
          buildIdentity(runningHrc) !== buildIdentity(installedBuilds.hrcBuild))
      ) {
        findings.add('running HRC build identity does not match ACP installed HRC')
      }
    }
  }

  return {
    ok: findings.size === 0,
    expected: EXPECTED_CONSUMER_PRODUCERS,
    installed: installedBuilds,
    ...(running !== undefined ? { running } : {}),
    informational: describeSetVersions(installedBuilds, running),
    findings: [...findings],
  }
}

function describeSetVersions(
  installedBuilds: {
    aspBuild?: PraesidiumBuild | undefined
    hrcBuild?: PraesidiumBuild | undefined
  },
  running: Record<string, unknown> | undefined
): string[] {
  const lines: string[] = []
  for (const setName of ['asp', 'hrc'] as const) {
    const key = setName === 'asp' ? 'aspBuild' : 'hrcBuild'
    const installed = installedBuilds[key]
    const runningRaw = running?.[key]
    const runningBuild = isPraesidiumBuild(runningRaw) ? runningRaw : undefined
    if (installed !== undefined) {
      lines.push(
        `${setName}: installed set ${installed.setVersion} built ${installed.builtAt}; canonicalRemote ${installed.canonicalRemote}`
      )
    }
    if (runningBuild !== undefined) {
      lines.push(
        `${setName}: running set ${runningBuild.setVersion} built ${runningBuild.builtAt}; canonicalRemote ${runningBuild.canonicalRemote}`
      )
    }
    if (
      installed !== undefined &&
      runningBuild !== undefined &&
      buildIdentity(installed) === buildIdentity(runningBuild) &&
      installed.setVersion !== runningBuild.setVersion
    ) {
      lines.push(
        `${setName}: installed and running sets were minted separately from source commit ${installed.sourceCommit}`
      )
    }
  }
  return lines
}

type InstalledManifest = {
  name?: string
  version?: string
  praesidiumBuild?: unknown
}

type RawConsumerManifest = {
  workspaces?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  overrides?: Record<string, string>
}

async function consumerManifestPaths(repoRoot: string): Promise<string[]> {
  const paths = new Set<string>([resolve(repoRoot, 'package.json')])
  const root = JSON.parse(
    await readFile(resolve(repoRoot, 'package.json'), 'utf8')
  ) as RawConsumerManifest
  for (const pattern of root.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const base = resolve(repoRoot, pattern.slice(0, -2))
      for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue
        const path = join(base, entry.name, 'package.json')
        if ((await stat(path).catch(() => undefined))?.isFile()) paths.add(path)
      }
    } else {
      const path = resolve(repoRoot, pattern, 'package.json')
      if ((await stat(path).catch(() => undefined))?.isFile()) paths.add(path)
    }
  }
  return [...paths]
}

function lockKeyFromManifestPath(path: string): string | undefined {
  const marker = 'node_modules/'
  const start = path.indexOf(marker)
  if (start === -1 || !path.endsWith('/package.json')) return undefined
  return path
    .slice(start + marker.length, -'/package.json'.length)
    .split('/node_modules/')
    .join('/')
}

export async function readConsumerDeploymentInputs(
  repoRoot: string
): Promise<ConsumerDeploymentInputs> {
  const lockText = await readFile(resolve(repoRoot, 'bun.lock'), 'utf8')
  const installed: InstalledProducerPackage[] = []
  const glob = new Bun.Glob('node_modules/**/package.json')
  for await (const manifestPath of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
    try {
      const manifest = JSON.parse(
        await readFile(resolve(repoRoot, manifestPath), 'utf8')
      ) as InstalledManifest
      if (!isPraesidiumBuild(manifest.praesidiumBuild)) continue
      installed.push({
        lockKey: lockKeyFromManifestPath(manifestPath),
        manifestPath,
        name: manifest.name ?? '',
        version: manifest.version ?? '',
        praesidiumBuild: manifest.praesidiumBuild,
      })
    } catch {
      // The evaluator fails closed for members it can identify from another installed selection.
    }
  }
  const manifests: ConsumerManifest[] = []
  for (const path of await consumerManifestPaths(repoRoot)) {
    const raw = JSON.parse(await readFile(path, 'utf8')) as RawConsumerManifest
    manifests.push({
      path: relative(repoRoot, path),
      ...(raw.dependencies !== undefined ? { dependencies: raw.dependencies } : {}),
      ...(raw.devDependencies !== undefined ? { devDependencies: raw.devDependencies } : {}),
      ...(raw.overrides !== undefined ? { overrides: raw.overrides } : {}),
    })
  }
  return { lockText, installed, manifests }
}

export function listConsumerLockSelections(
  lockText: string,
  installed?: readonly InstalledProducerPackage[]
): readonly ConsumerLockSelection[] {
  const selections = allLockSelections(lockText)
  if (installed === undefined) return selections
  const members = new Set(tupleMembers(installed).keys())
  return selections.filter((selection) => members.has(selection.name))
}
