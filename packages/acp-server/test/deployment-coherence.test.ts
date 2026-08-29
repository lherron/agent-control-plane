import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  EXPECTED_CONSUMER_PRODUCERS,
  type ExpectedConsumerProducer,
  type InstalledProducerPackage,
  type PraesidiumBuild,
  evaluateConsumerDeployment,
  listConsumerLockSelections,
  readConsumerDeploymentInputs,
} from '../src/deployment-coherence.js'
import type { AcpHrcClient } from '../src/index.js'
import { isSourceLinkedCheckout } from './fixtures/source-linked'
import { withWiredServer } from './fixtures/wired-server.js'

const TEST_EXPECTED_CONSUMER_PRODUCERS = [
  {
    setName: 'asp',
    setVersion: '1.2.3-test',
    repository: 'agent-spaces',
    canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
    sourceCommit: 'a'.repeat(40),
  },
  {
    setName: 'hrc',
    setVersion: '4.5.6-test',
    repository: 'hrc-runtime',
    canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
    sourceCommit: 'b'.repeat(40),
  },
] as const satisfies readonly ExpectedConsumerProducer[]

function expectedProducer(
  setName: 'asp' | 'hrc',
  expected: readonly ExpectedConsumerProducer[] = TEST_EXPECTED_CONSUMER_PRODUCERS
): ExpectedConsumerProducer {
  const producer = expected.find((candidate) => candidate.setName === setName)
  if (producer === undefined) throw new Error(`missing ${setName} producer fixture`)
  return producer
}

function buildFor(
  setName: 'asp' | 'hrc',
  builtAt: string,
  expected: readonly ExpectedConsumerProducer[] = TEST_EXPECTED_CONSUMER_PRODUCERS
): PraesidiumBuild {
  const producer = expectedProducer(setName, expected)
  return { schema: 1, ...producer, builtAt }
}

function differentSourceCommit(sourceCommit: string): string {
  const replacement = sourceCommit.endsWith('0') ? '1' : '0'
  return `${sourceCommit.slice(0, -1)}${replacement}`
}

const aspBuild = buildFor('asp', '2026-08-26T02:37:56.457Z')
const hrcBuild = buildFor('hrc', '2026-08-26T02:55:56.445Z')

const fixturePackages = {
  asp: ['agent-scope', 'spaces-aspc-facade'],
  hrc: ['hrc-core'],
} as const

function lockEntry(name: string, version: string, lockKey = name): string {
  return `    "${lockKey}": ["${name}@${version}", "http://mini:4873/${name}/-/${name}-${version}.tgz", {}, "sha512-dGVzdA=="],`
}

function coherentFixture(
  expected: readonly ExpectedConsumerProducer[] = TEST_EXPECTED_CONSUMER_PRODUCERS
) {
  const fixtureAspBuild = buildFor('asp', aspBuild.builtAt, expected)
  const fixtureHrcBuild = buildFor('hrc', hrcBuild.builtAt, expected)
  const installed: InstalledProducerPackage[] = []
  const lockLines: string[] = []
  for (const producer of expected) {
    for (const name of fixturePackages[producer.setName]) {
      lockLines.push(lockEntry(name, producer.setVersion))
      installed.push({
        name,
        version: producer.setVersion,
        praesidiumBuild: producer.setName === 'asp' ? fixtureAspBuild : fixtureHrcBuild,
      })
    }
  }
  return {
    lockText: lockLines.join('\n'),
    installed,
    manifests: [
      {
        path: 'package.json',
        dependencies: Object.fromEntries(
          expected.flatMap((producer) =>
            fixturePackages[producer.setName].map((name) => [name, producer.setVersion])
          )
        ),
        overrides: Object.fromEntries(
          expected.flatMap((producer) =>
            fixturePackages[producer.setName].map((name) => [name, producer.setVersion])
          )
        ),
      },
    ],
    runningStatus: {
      release: {
        mode: 'atomic',
        releaseId: 'release-test',
        hrcBuild: fixtureHrcBuild,
        aspBuild: fixtureAspBuild,
        runningEqualsInstalled: true,
      },
    },
  }
}

describe('ASP/HRC consumer deployment coherence', () => {
  test('accepts one canonical lock/install tuple that matches the served atomic release', () => {
    const report = evaluateConsumerDeployment(coherentFixture(), TEST_EXPECTED_CONSUMER_PRODUCERS)

    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.expected).toEqual(TEST_EXPECTED_CONSUMER_PRODUCERS)
    expect(report.expected).not.toEqual(EXPECTED_CONSUMER_PRODUCERS)
    expect(report.installed).toEqual({ aspBuild, hrcBuild })
    expect(report.running).toMatchObject({
      mode: 'atomic',
      releaseId: 'release-test',
      runningEqualsInstalled: true,
    })
  })

  test('accepts a running set minted on another node from the same source commit', () => {
    const fixture = coherentFixture()
    const runningHrcBuild = {
      ...hrcBuild,
      setVersion: `${hrcBuild.setVersion}-other-node`,
      builtAt: '2026-08-26T02:40:48.000Z',
    }
    fixture.runningStatus.release = { ...fixture.runningStatus.release, hrcBuild: runningHrcBuild }
    const report = evaluateConsumerDeployment(fixture, TEST_EXPECTED_CONSUMER_PRODUCERS)

    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.informational).toEqual(
      expect.arrayContaining([
        `hrc: installed set ${hrcBuild.setVersion} built ${hrcBuild.builtAt}; canonicalRemote ${hrcBuild.canonicalRemote}`,
        `hrc: running set ${runningHrcBuild.setVersion} built ${runningHrcBuild.builtAt}; canonicalRemote ${runningHrcBuild.canonicalRemote}`,
        `hrc: installed and running sets were minted separately from source commit ${hrcBuild.sourceCommit}`,
      ])
    )
  })

  test('accepts an alias-stamped tuple from the same source commit and reports the spelling', () => {
    const fixture = coherentFixture()
    const aliasRemote = 'git@gh-hrc-runtime:lherron/hrc-runtime.git'
    const aliasBuild = { ...hrcBuild, canonicalRemote: aliasRemote }
    fixture.installed = fixture.installed.map((entry) =>
      entry.name === 'hrc-core' ? { ...entry, praesidiumBuild: aliasBuild } : entry
    )
    fixture.runningStatus.release = { ...fixture.runningStatus.release, hrcBuild: aliasBuild }

    const report = evaluateConsumerDeployment(fixture, TEST_EXPECTED_CONSUMER_PRODUCERS)

    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.installed.hrcBuild?.canonicalRemote).toBe(aliasRemote)
    expect(report.informational).toEqual(
      expect.arrayContaining([
        `hrc: installed set ${aliasBuild.setVersion} built ${aliasBuild.builtAt}; canonicalRemote ${aliasRemote}`,
        `hrc: running set ${aliasBuild.setVersion} built ${aliasBuild.builtAt}; canonicalRemote ${aliasRemote}`,
      ])
    )
  })

  test('still fails closed on a different source commit with the same remote spelling', () => {
    const fixture = coherentFixture()
    fixture.runningStatus.release = {
      ...fixture.runningStatus.release,
      hrcBuild: { ...hrcBuild, sourceCommit: differentSourceCommit(hrcBuild.sourceCommit) },
    }

    const report = evaluateConsumerDeployment(fixture, TEST_EXPECTED_CONSUMER_PRODUCERS)

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(['running HRC build identity does not match ACP installed HRC'])
  })

  test.skipIf(isSourceLinkedCheckout())(
    'serves the lock/install/running readback through ACP',
    async () => {
      const productionFixture = coherentFixture(EXPECTED_CONSUMER_PRODUCERS)
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: '/v1/admin/deployment-coherence',
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            ok: boolean
            expected: readonly ExpectedConsumerProducer[]
            installed: { aspBuild?: PraesidiumBuild; hrcBuild?: PraesidiumBuild }
            running: { releaseId: string; runningEqualsInstalled: boolean }
            findings: string[]
          }>(response)
          expect(body).toMatchObject({
            ok: true,
            running: {
              releaseId: 'release-test',
              runningEqualsInstalled: true,
            },
            findings: [],
          })
          for (const expected of body.expected) {
            const installed =
              expected.setName === 'asp' ? body.installed.aspBuild : body.installed.hrcBuild
            expect(installed).toMatchObject({
              schema: 1,
              repository: expected.repository,
              sourceCommit: expected.sourceCommit,
              setName: expected.setName,
              setVersion: expected.setVersion,
            })
          }
        },
        {
          hrcClient: {
            getStatus: async () => productionFixture.runningStatus,
          } as unknown as AcpHrcClient,
        }
      )
    }
  )

  test('fails closed on lock, locator, installed tuple, and running-release drift', () => {
    const fixture = coherentFixture()
    const aspPackage = fixturePackages.asp[0]
    const hrcPackage = fixturePackages.hrc[0]
    if (aspPackage === undefined || hrcPackage === undefined) throw new Error('invalid fixture')
    const staleVersion = `${aspBuild.setVersion}-stale`

    fixture.lockText = fixture.lockText
      .replace(lockEntry(aspPackage, aspBuild.setVersion), lockEntry(aspPackage, staleVersion))
      .replace(
        lockEntry(hrcPackage, hrcBuild.setVersion),
        lockEntry(hrcPackage, hrcBuild.setVersion).replace(
          'http://mini:4873/',
          'http://127.0.0.1:4873/'
        )
      )
    fixture.installed = fixture.installed.map((entry) =>
      entry.name === aspPackage ? { ...entry, version: staleVersion } : entry
    )
    fixture.runningStatus.release = {
      ...fixture.runningStatus.release,
      mode: 'unmanaged',
      aspBuild: { ...aspBuild, sourceCommit: differentSourceCommit(aspBuild.sourceCommit) },
      runningEqualsInstalled: false,
    }

    const report = evaluateConsumerDeployment(fixture, TEST_EXPECTED_CONSUMER_PRODUCERS)

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${aspPackage}: lock selects ${staleVersion}`),
        expect.stringContaining(`${hrcPackage}: lock tarball is not canonical`),
        expect.stringContaining(`${aspPackage}: installed version ${staleVersion}`),
        expect.stringContaining('running HRC release is unmanaged'),
        expect.stringContaining('running HRC release does not equal the installed release'),
        expect.stringContaining('running ASP build identity does not match ACP installed ASP'),
      ])
    )
  })

  test('rejects a missing build record and disagreement within one installed set', () => {
    const fixture = coherentFixture()
    const [first, second] = fixturePackages.asp
    if (first === undefined || second === undefined) throw new Error('invalid fixture')

    fixture.installed = fixture.installed.map((entry) => {
      if (entry.name === first) return { name: entry.name, version: entry.version }
      if (entry.name === second) {
        return {
          ...entry,
          praesidiumBuild: {
            ...aspBuild,
            sourceCommit: differentSourceCommit(aspBuild.sourceCommit),
          },
        }
      }
      return entry
    })

    const report = evaluateConsumerDeployment(fixture, TEST_EXPECTED_CONSUMER_PRODUCERS)

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        `${first}: root override does not name a tuple-bearing producer package`,
        expect.stringContaining('installed build tuple does not match expected asp set'),
      ])
    )
  })

  test('rejects a stale nested Bun resolution and its installed shadow', () => {
    const fixture = coherentFixture()
    const packageName = fixturePackages.asp[0]
    if (packageName === undefined) throw new Error('invalid fixture')
    const lockKey = `hrc-core/${packageName}`
    const staleVersion = `${aspBuild.setVersion}-stale`

    fixture.lockText = `${fixture.lockText}\n${lockEntry(packageName, staleVersion, lockKey)}`
    fixture.installed = [
      {
        lockKey,
        name: packageName,
        version: staleVersion,
        praesidiumBuild: { ...aspBuild, setVersion: staleVersion },
      },
      ...fixture.installed,
    ]

    const report = evaluateConsumerDeployment(fixture, TEST_EXPECTED_CONSUMER_PRODUCERS)
    const selections = listConsumerLockSelections(fixture.lockText).filter(
      (selection) => selection.name === packageName
    )

    expect(report.ok).toBe(false)
    expect(selections.map((selection) => selection.lockKey)).toEqual([packageName, lockKey])
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${lockKey}: lock selects ${staleVersion}`),
        expect.stringContaining(`${lockKey}: installed version ${staleVersion}`),
      ])
    )
  })

  test('reads and validates the manifest installed at a nested Bun shadow path', async () => {
    const fixture = coherentFixture()
    const packageName = fixturePackages.asp[0]
    if (packageName === undefined) throw new Error('invalid fixture')
    const lockKey = `hrc-core/${packageName}`
    const staleVersion = `${aspBuild.setVersion}-stale`
    fixture.lockText = `${fixture.lockText}\n${lockEntry(packageName, staleVersion, lockKey)}`
    const repoRoot = await mkdtemp(join(tmpdir(), 'acp-deployment-coherence-'))

    try {
      await writeFile(join(repoRoot, 'bun.lock'), fixture.lockText)
      await writeFile(
        join(repoRoot, 'package.json'),
        JSON.stringify({
          overrides: Object.fromEntries(
            TEST_EXPECTED_CONSUMER_PRODUCERS.flatMap((producer) =>
              fixturePackages[producer.setName].map((name) => [name, producer.setVersion])
            )
          ),
        })
      )
      for (const producer of TEST_EXPECTED_CONSUMER_PRODUCERS) {
        for (const name of fixturePackages[producer.setName]) {
          const manifestRoot = join(repoRoot, 'node_modules', name)
          await mkdir(manifestRoot, { recursive: true })
          await writeFile(
            join(manifestRoot, 'package.json'),
            JSON.stringify({
              name,
              version: producer.setVersion,
              praesidiumBuild: producer.setName === 'asp' ? aspBuild : hrcBuild,
            })
          )
        }
      }
      const nestedManifestRoot = join(
        repoRoot,
        'node_modules',
        'hrc-core',
        'node_modules',
        packageName
      )
      await mkdir(nestedManifestRoot, { recursive: true })
      await writeFile(
        join(nestedManifestRoot, 'package.json'),
        JSON.stringify({
          name: packageName,
          version: staleVersion,
          praesidiumBuild: { ...aspBuild, setVersion: staleVersion },
        })
      )

      const inputs = await readConsumerDeploymentInputs(repoRoot)
      const nested = inputs.installed.find((entry) => entry.lockKey === lockKey)
      const report = evaluateConsumerDeployment(inputs, TEST_EXPECTED_CONSUMER_PRODUCERS)

      expect(nested).toMatchObject({
        lockKey,
        name: packageName,
        version: staleVersion,
      })
      expect(report.ok).toBe(false)
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${lockKey}: lock selects ${staleVersion}`),
          expect.stringContaining(`${lockKey}: installed version ${staleVersion}`),
        ])
      )
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})
