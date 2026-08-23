import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  EXPECTED_CONSUMER_PRODUCERS,
  type InstalledProducerPackage,
  evaluateConsumerDeployment,
  listConsumerLockSelections,
  readConsumerDeploymentInputs,
} from '../src/deployment-coherence.js'
import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

const aspBuild = {
  schema: 1 as const,
  repository: 'agent-spaces',
  canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
  sourceCommit: '3aefda508d88fe7e09bffa68c4d28c053ebfb53f',
  setName: 'asp' as const,
  setVersion: '0.1.1-dev.20260823052310',
  builtAt: '2026-08-23T10:23:09.830Z',
}

const hrcBuild = {
  schema: 1 as const,
  repository: 'hrc-runtime',
  canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
  sourceCommit: 'ccc9e61f46e5c906e93195c5c92bdfe966fa6c82',
  setName: 'hrc' as const,
  setVersion: '0.1.0-dev.20260823130859',
  builtAt: '2026-08-23T18:08:57.882Z',
}

function lockEntry(name: string, version: string, lockKey = name): string {
  return `    "${lockKey}": ["${name}@${version}", "http://mini:4873/${name}/-/${name}-${version}.tgz", {}, "sha512-dGVzdA=="],`
}

function coherentFixture() {
  const installed: InstalledProducerPackage[] = []
  const lockLines: string[] = []
  for (const producer of EXPECTED_CONSUMER_PRODUCERS) {
    for (const name of producer.packages) {
      lockLines.push(lockEntry(name, producer.setVersion))
      installed.push({
        name,
        version: producer.setVersion,
        praesidiumBuild: producer.setName === 'asp' ? aspBuild : hrcBuild,
      })
    }
  }
  return {
    lockText: lockLines.join('\n'),
    installed,
    runningStatus: {
      release: {
        mode: 'atomic',
        releaseId: 'release-test',
        hrcBuild,
        aspBuild,
        runningEqualsInstalled: true,
      },
    },
  }
}

describe('ASP/HRC consumer deployment coherence', () => {
  test('accepts one canonical lock/install tuple that matches the served atomic release', () => {
    const report = evaluateConsumerDeployment(coherentFixture())

    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.installed).toEqual({ aspBuild, hrcBuild })
    expect(report.running).toMatchObject({
      mode: 'atomic',
      releaseId: 'release-test',
      runningEqualsInstalled: true,
    })
  })

  test('serves the lock/install/running readback through ACP', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: '/v1/admin/deployment-coherence',
        })
        expect(response.status).toBe(200)
        expect(
          await fixture.json<{
            ok: boolean
            installed: { aspBuild: typeof aspBuild; hrcBuild: typeof hrcBuild }
            running: { releaseId: string; runningEqualsInstalled: boolean }
            findings: string[]
          }>(response)
        ).toMatchObject({
          ok: true,
          installed: { aspBuild, hrcBuild },
          running: {
            releaseId: 'release-test',
            runningEqualsInstalled: true,
          },
          findings: [],
        })
      },
      {
        hrcClient: {
          getStatus: async () => coherentFixture().runningStatus,
        } as unknown as AcpHrcClient,
      }
    )
  })

  test('fails closed on lock, locator, installed tuple, and running-release drift', () => {
    const fixture = coherentFixture()
    const aspPackage = EXPECTED_CONSUMER_PRODUCERS[0]?.packages[0]
    const hrcPackage = EXPECTED_CONSUMER_PRODUCERS[1]?.packages[0]
    if (aspPackage === undefined || hrcPackage === undefined) throw new Error('invalid fixture')

    fixture.lockText = fixture.lockText
      .replace(
        lockEntry(aspPackage, aspBuild.setVersion),
        lockEntry(aspPackage, '0.1.1-dev.20260721071843')
      )
      .replace(
        lockEntry(hrcPackage, hrcBuild.setVersion),
        lockEntry(hrcPackage, hrcBuild.setVersion).replace(
          'http://mini:4873/',
          'http://127.0.0.1:4873/'
        )
      )
    fixture.installed = fixture.installed.filter((entry) => entry.name !== aspPackage)
    fixture.runningStatus.release = {
      ...fixture.runningStatus.release,
      mode: 'unmanaged',
      aspBuild: { ...aspBuild, sourceCommit: 'stale' },
      runningEqualsInstalled: false,
    }

    const report = evaluateConsumerDeployment(fixture)

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${aspPackage}: lock selects 0.1.1-dev.20260721071843`),
        expect.stringContaining(`${hrcPackage}: lock tarball is not canonical`),
        expect.stringContaining(`${aspPackage}: installed manifest is missing`),
        expect.stringContaining('running HRC release is unmanaged'),
        expect.stringContaining('running HRC release does not equal the installed release'),
        expect.stringContaining('running ASP build tuple does not match ACP installed ASP'),
      ])
    )
  })

  test('rejects a missing build record and disagreement within one installed set', () => {
    const fixture = coherentFixture()
    const [first, second] = EXPECTED_CONSUMER_PRODUCERS[0]?.packages ?? []
    if (first === undefined || second === undefined) throw new Error('invalid fixture')

    fixture.installed = fixture.installed.map((entry) => {
      if (entry.name === first) return { name: entry.name, version: entry.version }
      if (entry.name === second) {
        return {
          ...entry,
          praesidiumBuild: { ...aspBuild, builtAt: '2026-07-25T06:23:00.000Z' },
        }
      }
      return entry
    })

    const report = evaluateConsumerDeployment(fixture)

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        `${first}: installed manifest has no praesidiumBuild tuple`,
        expect.stringContaining('installed build tuple disagrees with asp set'),
      ])
    )
  })

  test('rejects a stale nested Bun resolution and its installed shadow', () => {
    const fixture = coherentFixture()
    const packageName = EXPECTED_CONSUMER_PRODUCERS[0]?.packages[0]
    if (packageName === undefined) throw new Error('invalid fixture')
    const lockKey = `hrc-core/${packageName}`
    const staleVersion = '0.1.1-dev.20260721071843'

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

    const report = evaluateConsumerDeployment(fixture)
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
    const packageName = EXPECTED_CONSUMER_PRODUCERS[0]?.packages[0]
    if (packageName === undefined) throw new Error('invalid fixture')
    const lockKey = `hrc-core/${packageName}`
    const staleVersion = '0.1.1-dev.20260721071843'
    fixture.lockText = `${fixture.lockText}\n${lockEntry(packageName, staleVersion, lockKey)}`
    const repoRoot = await mkdtemp(join(tmpdir(), 'acp-deployment-coherence-'))

    try {
      await writeFile(join(repoRoot, 'bun.lock'), fixture.lockText)
      for (const producer of EXPECTED_CONSUMER_PRODUCERS) {
        for (const name of producer.packages) {
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
      const report = evaluateConsumerDeployment(inputs)

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
