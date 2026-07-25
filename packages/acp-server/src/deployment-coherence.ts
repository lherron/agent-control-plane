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
  setVersion: string
  repository: string
  canonicalRemote: string
  sourceCommit: string
  packages: readonly string[]
}>

export const EXPECTED_CONSUMER_PRODUCERS = [
  {
    setName: 'asp',
    setVersion: '0.1.1-dev.20260725012231',
    repository: 'agent-spaces',
    canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
    sourceCommit: 'a385ad0059013667b05ff27e87b360b97f0fa2ae',
    packages: [
      'agent-scope',
      'agent-spaces',
      'cli-kit',
      'spaces-aspc',
      'spaces-aspc-protocol',
      'spaces-config',
      'spaces-execution',
      'spaces-harness-broker',
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
    setVersion: '0.1.0-dev.20260725013259',
    repository: 'hrc-runtime',
    canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
    sourceCommit: '3952456c9a18d04672783ecff6a99dee158827db',
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
  name: string
  version: string
  praesidiumBuild?: PraesidiumBuild | undefined
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
  findings: readonly string[]
}>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stableBuild(build: PraesidiumBuild): string {
  return JSON.stringify(PRAESIDIUM_BUILD_FIELDS.map((field) => build[field]))
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
    build.setName === expected.setName &&
    build.setVersion === expected.setVersion
  )
}

function lockSelection(
  lockText: string,
  name: string
): Readonly<{ name: string; version: string; tarball: string; integrity: string }> | undefined {
  const quotedName = escapeRegExp(JSON.stringify(name))
  const resolutionPrefix = escapeRegExp(`"${name}@`)
  const pattern = new RegExp(
    `^\\s*${quotedName}:\\s*\\[${resolutionPrefix}([^"]+)",\\s*"([^"]+)"[^\\n]*"(sha512-[A-Za-z0-9+/=]+)"\\],?$`,
    'm'
  )
  const match = pattern.exec(lockText)
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined
  }
  return { name, version: match[1], tarball: match[2], integrity: match[3] }
}

function expectedTarball(name: string, version: string): string {
  return `http://mini:4873/${name}/-/${name}-${version}.tgz`
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
  const installedByName = new Map(input.installed.map((entry) => [entry.name, entry]))
  const installedBuilds: {
    aspBuild?: PraesidiumBuild | undefined
    hrcBuild?: PraesidiumBuild | undefined
  } = {}

  for (const producer of EXPECTED_CONSUMER_PRODUCERS) {
    let coherentBuild: PraesidiumBuild | undefined
    for (const name of producer.packages) {
      const selection = lockSelection(input.lockText, name)
      if (selection === undefined) {
        findings.push(`${name}: lock selection is missing`)
      } else {
        if (selection.version !== producer.setVersion) {
          findings.push(
            `${name}: lock selects ${selection.version}; expected ${producer.setVersion}`
          )
        }
        if (selection.tarball !== expectedTarball(name, selection.version)) {
          findings.push(`${name}: lock tarball is not canonical: ${selection.tarball}`)
        }
      }

      const installed = installedByName.get(name)
      if (installed === undefined) {
        findings.push(`${name}: installed manifest is missing`)
        continue
      }
      if (installed.version !== producer.setVersion) {
        findings.push(
          `${name}: installed version ${installed.version}; expected ${producer.setVersion}`
        )
      }
      if (!isPraesidiumBuild(installed.praesidiumBuild)) {
        findings.push(`${name}: installed manifest has no praesidiumBuild tuple`)
        continue
      }
      if (!expectedBuildFieldsMatch(installed.praesidiumBuild, producer)) {
        findings.push(
          `${name}: installed build tuple does not match expected ${producer.setName} set`
        )
      }
      if (coherentBuild === undefined) {
        coherentBuild = installed.praesidiumBuild
      } else if (stableBuild(installed.praesidiumBuild) !== stableBuild(coherentBuild)) {
        findings.push(`${name}: installed build tuple disagrees with ${producer.setName} set`)
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
          stableBuild(runningAsp) !== stableBuild(installedBuilds.aspBuild))
      ) {
        findings.push('running ASP build tuple does not match ACP installed ASP')
      }
      if (
        installedBuilds.hrcBuild !== undefined &&
        (!isPraesidiumBuild(runningHrc) ||
          stableBuild(runningHrc) !== stableBuild(installedBuilds.hrcBuild))
      ) {
        findings.push('running HRC build tuple does not match ACP installed HRC')
      }
    }
  }

  return {
    ok: findings.length === 0,
    expected: EXPECTED_CONSUMER_PRODUCERS,
    installed: installedBuilds,
    ...(running !== undefined ? { running } : {}),
    findings,
  }
}

type InstalledManifest = {
  name?: string
  version?: string
  praesidiumBuild?: unknown
}

export async function readConsumerDeploymentInputs(
  repoRoot: string
): Promise<{ lockText: string; installed: InstalledProducerPackage[] }> {
  const installed: InstalledProducerPackage[] = []
  for (const producer of EXPECTED_CONSUMER_PRODUCERS) {
    for (const name of producer.packages) {
      const manifestPath = resolve(repoRoot, 'node_modules', name, 'package.json')
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as InstalledManifest
        installed.push({
          name,
          version: manifest.version ?? '',
          ...(isPraesidiumBuild(manifest.praesidiumBuild)
            ? { praesidiumBuild: manifest.praesidiumBuild }
            : {}),
        })
      } catch {
        // The evaluator owns the fail-closed diagnostic for absent manifests.
      }
    }
  }
  return {
    lockText: await readFile(resolve(repoRoot, 'bun.lock'), 'utf8'),
    installed,
  }
}

export function listConsumerLockSelections(
  lockText: string
): ReadonlyArray<Readonly<{ name: string; version: string; tarball: string; integrity: string }>> {
  return EXPECTED_CONSUMER_PRODUCERS.flatMap((producer) =>
    producer.packages.flatMap((name) => {
      const selection = lockSelection(lockText, name)
      return selection === undefined ? [] : [selection]
    })
  )
}
