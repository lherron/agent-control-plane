import { describe, expect, test } from 'bun:test'

import {
  type ConsumerManifest,
  EXPECTED_CONSUMER_PRODUCERS,
  type InstalledProducerPackage,
  evaluateConsumerDeployment,
} from './deployment-coherence.js'

const asp = EXPECTED_CONSUMER_PRODUCERS.find((producer) => producer.setName === 'asp')
if (asp === undefined) throw new Error('ASP producer fixture is missing')

const build = {
  schema: 1 as const,
  repository: asp.repository,
  canonicalRemote: asp.canonicalRemote,
  sourceCommit: asp.sourceCommit,
  setName: asp.setName,
  setVersion: asp.setVersion,
  builtAt: '2026-08-28T00:00:00.000Z',
}

const packages = ['agent-scope', 'spaces-aspc-facade'] as const

function lockEntry(name: string): string {
  return `    "${name}": ["${name}@${asp.setVersion}", "http://mini:4873/${name}/-/${name}-${asp.setVersion}.tgz", {}, "sha512-dGVzdA=="],`
}

function fixture(): {
  lockText: string
  installed: InstalledProducerPackage[]
  manifests: ConsumerManifest[]
} {
  return {
    lockText: packages.map(lockEntry).join('\n'),
    installed: packages.map((name) => ({
      name,
      version: asp.setVersion,
      praesidiumBuild: build,
    })),
    manifests: [
      {
        path: 'package.json',
        dependencies: { 'agent-scope': asp.setVersion },
        overrides: Object.fromEntries(packages.map((name) => [name, asp.setVersion])),
      },
    ],
  }
}

describe('derived producer pin coverage', () => {
  test('an omitted transitive member override is a finding', () => {
    const input = fixture()
    input.manifests[0] = {
      ...input.manifests[0],
      overrides: { 'agent-scope': asp.setVersion },
    }

    const report = evaluateConsumerDeployment(input)

    expect(report.ok).toBe(false)
    expect(report.findings).toContain(
      `spaces-aspc-facade: root override missing; expected ${asp.setVersion}`
    )
  })

  test('a member carrying a foreign sourceCommit is a finding', () => {
    const input = fixture()
    input.installed[1] = {
      ...input.installed[1],
      praesidiumBuild: { ...build, sourceCommit: 'f'.repeat(40) },
    }

    const report = evaluateConsumerDeployment(input)

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        'spaces-aspc-facade: installed build tuple does not match expected asp set',
        'spaces-aspc-facade: installed build tuple disagrees with asp set',
      ])
    )
  })

  test('an unknown setName is a finding', () => {
    const input = fixture()
    input.installed[1] = {
      ...input.installed[1],
      praesidiumBuild: { ...build, setName: 'guest' },
    }

    const report = evaluateConsumerDeployment(input)

    expect(report.ok).toBe(false)
    expect(report.findings).toContain(
      'spaces-aspc-facade: installed manifest names unknown producer set guest'
    )
  })
})
