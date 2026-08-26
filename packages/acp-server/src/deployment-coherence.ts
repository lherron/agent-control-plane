import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const PRAESIDIUM_BUILD_FIELDS = [
  'schema',
  'repository',
  'canonicalRemote',
  'sourceCommit',
  'setName',
  'setVersion',
  'builtAt',
] as const

/**
 * The coherence identity of a producer set. `setVersion` and `builtAt` are deliberately
 * absent: every node mints its own canonical set from the same source commit, so those two
 * fields are per-node informational and must never drive a finding.
 */
export const PRAESIDIUM_BUILD_IDENTITY_FIELDS = [
  'schema',
  'repository',
  'canonicalRemote',
  'sourceCommit',
  'setName',
] as const

export type PraesidiumBuild = Readonly<{
  schema: 1
  repository: string
  canonicalRemote: string
  sourceCommit: string
  setName: 'asp' | 'hrc'
  setVersion: string
  builtAt: string
}>

type ExpectedConsumerProducer = Readonly<{
  setName: 'asp' | 'hrc'
  /**
   * The concrete version pinned by `package.json` overrides and `bun.lock`. Bun needs one
   * version to resolve, and both files are committed, so this is identical on every node.
   * It is a pin, not an identity: coherence is decided by `sourceCommit`, and a set minted
   * on another node from the same commit under a different `setVersion` is still coherent.
   */
  setVersion: string
  repository: string
  canonicalRemote: string
  /** The coherence identity of this producer set, together with the three fields above. */
  sourceCommit: string
  packages: readonly string[]
}>

export const EXPECTED_CONSUMER_PRODUCERS = [
  {
    setName: 'asp',
    setVersion: '0.1.1-dev.20260825213756',
    repository: 'agent-spaces',
    canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
    sourceCommit: '1e3231ec8d3ccc38c50b9f61fb8deeacc8ef60d4',
    packages: [
      'agent-scope',
      'agent-spaces',
      'cli-kit',
      'spaces-aspc',
      'spaces-aspc-protocol',
      'spaces-config',
      'spaces-execution',
      'spaces-harness-broker-client',
      'spaces-harness-broker-protocol',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-runtime',
      'spaces-runtime-contracts',
    ],
  },
  {
    setName: 'hrc',
    setVersion: '0.1.0-dev.20260825215557',
    repository: 'hrc-runtime',
    canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
    sourceCommit: '8f104d1055005d5253e54ef17b0685c82fbc43e8',
    packages: [
      'agent-action-render',
      'hrc-core',
      'hrc-events',
      'hrc-frame-render',
      'hrc-sdk',
      'hrc-server',
      'hrc-store-sqlite',
    ],
  },
] as const satisfies readonly ExpectedConsumerProducer[]

export type InstalledProducerPackage = Readonly<{
  lockKey?: string | undefined
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

type RunningStatus = Readonly<{
  release?: unknown
}>

export type ConsumerDeploymentReport = Readonly<{
  ok: boolean
  expected: typeof EXPECTED_CONSUMER_PRODUCERS
  installed: Readonly<{
    aspBuild?: PraesidiumBuild | undefined
    hrcBuild?: PraesidiumBuild | undefined
  }>
  running?: Readonly<Record<string, unknown>> | undefined
  /** Per-node set versions and build timestamps. Never a coherence failure. */
  informational: readonly string[]
  findings: readonly string[]
}>

function buildIdentity(build: PraesidiumBuild): string {
  return JSON.stringify(PRAESIDIUM_BUILD_IDENTITY_FIELDS.map((field) => build[field]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPraesidiumBuild(value: unknown): value is PraesidiumBuild {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  const expectedKeys = [...PRAESIDIUM_BUILD_FIELDS].sort()
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    value['schema'] === 1 &&
    typeof value['repository'] === 'string' &&
    typeof value['canonicalRemote'] === 'string' &&
    typeof value['sourceCommit'] === 'string' &&
    (value['setName'] === 'asp' || value['setName'] === 'hrc') &&
    typeof value['setVersion'] === 'string' &&
    typeof value['builtAt'] === 'string' &&
    !Number.isNaN(Date.parse(value['builtAt']))
  )
}

function expectedBuildFieldsMatch(
  build: PraesidiumBuild,
  expected: ExpectedConsumerProducer
): boolean {
  return (
    build.schema === 1 &&
    build.repository === expected.repository &&
    build.canonicalRemote === expected.canonicalRemote &&
    build.sourceCommit === expected.sourceCommit &&
    build.setName === expected.setName
  )
}

function lockSelections(lockText: string, name: string): ConsumerLockSelection[] {
  const selections: ConsumerLockSelection[] = []
  const resolutionPrefix = `${name}@`
  for (const line of lockText.split(/\r?\n/)) {
    const match = /^\s*"([^"]+)":\s*\[\s*"([^"]+)"(?:,\s*"([^"]+)")?/.exec(line)
    const lockKey = match?.[1]
    const resolution = match?.[2]
    if (
      lockKey === undefined ||
      resolution === undefined ||
      !resolution.startsWith(resolutionPrefix)
    ) {
      continue
    }
    selections.push({
      lockKey,
      name,
      version: resolution.slice(resolutionPrefix.length),
      tarball: match?.[3] ?? '',
      integrity: /"(sha512-[A-Za-z0-9+/=]+)"\s*\],?\s*$/.exec(line)?.[1] ?? '',
    })
  }
  return selections
}

function expectedTarball(name: string, version: string): string {
  return `http://mini:4873/${name}/-/${name}-${version}.tgz`
}

function packageChainFromLockKey(lockKey: string): string[] {
  const segments = lockKey.split('/')
  const chain: string[] = []
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (segment === undefined || segment.length === 0) continue
    if (segment.startsWith('@') && segments[index + 1] !== undefined) {
      chain.push(`${segment}/${segments[index + 1]}`)
      index++
    } else {
      chain.push(segment)
    }
  }
  return chain
}

function installedManifestPath(repoRoot: string, lockKey: string): string {
  const chain = packageChainFromLockKey(lockKey)
  let packageRoot = resolve(repoRoot, 'node_modules')
  for (const [index, packageName] of chain.entries()) {
    packageRoot = resolve(packageRoot, packageName)
    if (index < chain.length - 1) packageRoot = resolve(packageRoot, 'node_modules')
  }
  return resolve(packageRoot, 'package.json')
}

function runningRelease(status: RunningStatus | undefined): Record<string, unknown> | undefined {
  return isRecord(status?.release) ? status.release : undefined
}

export function evaluateConsumerDeployment(input: {
  lockText: string
  installed: readonly InstalledProducerPackage[]
  runningStatus?: RunningStatus | undefined
}): ConsumerDeploymentReport {
  const findings: string[] = []
  const installedByLockKey = new Map(
    input.installed.map((entry) => [entry.lockKey ?? entry.name, entry])
  )
  const installedBuilds: {
    aspBuild?: PraesidiumBuild | undefined
    hrcBuild?: PraesidiumBuild | undefined
  } = {}

  for (const producer of EXPECTED_CONSUMER_PRODUCERS) {
    let coherentBuild: PraesidiumBuild | undefined
    for (const name of producer.packages) {
      const selections = lockSelections(input.lockText, name)
      if (selections.length === 0) {
        findings.push(`${name}: lock selection is missing`)
      }
      for (const selection of selections) {
        const label = selection.lockKey
        if (selection.version !== producer.setVersion) {
          findings.push(
            `${label}: lock selects ${selection.version}; expected ${producer.setVersion}`
          )
        }
        if (selection.tarball !== expectedTarball(name, selection.version)) {
          findings.push(`${label}: lock tarball is not canonical: ${selection.tarball}`)
        }
        if (selection.integrity.length === 0) {
          findings.push(`${label}: lock integrity is missing`)
        }

        const installed = installedByLockKey.get(selection.lockKey)
        if (installed === undefined) {
          findings.push(`${label}: installed manifest is missing`)
          continue
        }
        if (installed.name !== name) {
          findings.push(`${label}: installed manifest name ${installed.name}; expected ${name}`)
        }
        if (installed.version !== producer.setVersion) {
          findings.push(
            `${label}: installed version ${installed.version}; expected ${producer.setVersion}`
          )
        }
        if (!isPraesidiumBuild(installed.praesidiumBuild)) {
          findings.push(`${label}: installed manifest has no praesidiumBuild tuple`)
          continue
        }
        if (!expectedBuildFieldsMatch(installed.praesidiumBuild, producer)) {
          findings.push(
            `${label}: installed build tuple does not match expected ${producer.setName} set`
          )
        }
        if (coherentBuild === undefined) {
          coherentBuild = installed.praesidiumBuild
        } else if (buildIdentity(installed.praesidiumBuild) !== buildIdentity(coherentBuild)) {
          findings.push(`${label}: installed build tuple disagrees with ${producer.setName} set`)
        }
      }
    }
    if (producer.setName === 'asp') installedBuilds.aspBuild = coherentBuild
    else installedBuilds.hrcBuild = coherentBuild
  }

  const running = runningRelease(input.runningStatus)
  if (input.runningStatus !== undefined) {
    if (running === undefined) {
      findings.push('running HRC status has no release readback')
    } else {
      if (running['mode'] !== 'atomic') findings.push('running HRC release is unmanaged')
      if (running['runningEqualsInstalled'] !== true) {
        findings.push('running HRC release does not equal the installed release')
      }
      const runningAsp = running['aspBuild']
      const runningHrc = running['hrcBuild']
      if (
        installedBuilds.aspBuild !== undefined &&
        (!isPraesidiumBuild(runningAsp) ||
          buildIdentity(runningAsp) !== buildIdentity(installedBuilds.aspBuild))
      ) {
        findings.push('running ASP build identity does not match ACP installed ASP')
      }
      if (
        installedBuilds.hrcBuild !== undefined &&
        (!isPraesidiumBuild(runningHrc) ||
          buildIdentity(runningHrc) !== buildIdentity(installedBuilds.hrcBuild))
      ) {
        findings.push('running HRC build identity does not match ACP installed HRC')
      }
    }
  }

  return {
    ok: findings.length === 0,
    expected: EXPECTED_CONSUMER_PRODUCERS,
    installed: installedBuilds,
    ...(running !== undefined ? { running } : {}),
    informational: describeSetVersions(installedBuilds, running),
    findings,
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
    const installed = setName === 'asp' ? installedBuilds.aspBuild : installedBuilds.hrcBuild
    const runningRaw = running?.[key]
    const runningBuild = isPraesidiumBuild(runningRaw) ? runningRaw : undefined
    if (installed !== undefined) {
      lines.push(`${setName}: installed set ${installed.setVersion} built ${installed.builtAt}`)
    }
    if (runningBuild !== undefined) {
      lines.push(`${setName}: running set ${runningBuild.setVersion} built ${runningBuild.builtAt}`)
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

export async function readConsumerDeploymentInputs(
  repoRoot: string
): Promise<{ lockText: string; installed: InstalledProducerPackage[] }> {
  const lockText = await readFile(resolve(repoRoot, 'bun.lock'), 'utf8')
  const installed: InstalledProducerPackage[] = []
  for (const selection of listConsumerLockSelections(lockText)) {
    const manifestPath = installedManifestPath(repoRoot, selection.lockKey)
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as InstalledManifest
      installed.push({
        lockKey: selection.lockKey,
        name: manifest.name ?? '',
        version: manifest.version ?? '',
        ...(isPraesidiumBuild(manifest.praesidiumBuild)
          ? { praesidiumBuild: manifest.praesidiumBuild }
          : {}),
      })
    } catch {
      // The evaluator owns the fail-closed diagnostic for absent manifests.
    }
  }
  return { lockText, installed }
}

export function listConsumerLockSelections(lockText: string): readonly ConsumerLockSelection[] {
  return EXPECTED_CONSUMER_PRODUCERS.flatMap((producer) =>
    producer.packages.flatMap((name) => lockSelections(lockText, name))
  )
}
