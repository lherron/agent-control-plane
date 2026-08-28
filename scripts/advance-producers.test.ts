import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EXPECTED_CONSUMER_PRODUCERS,
  type PraesidiumBuild,
} from '../packages/acp-server/src/deployment-coherence.js'
import {
  type GitRunner,
  assertPostAdvanceConsumerDeployment,
  assertPublishedProducerIdentity,
  restoreFailedProducerAdvance,
} from './advance-producers.js'

const hrc = EXPECTED_CONSUMER_PRODUCERS.find((producer) => producer.setName === 'hrc')
if (hrc === undefined) throw new Error('HRC producer fixture is missing')

const build: PraesidiumBuild = {
  schema: 1,
  repository: hrc.repository,
  canonicalRemote: 'git@gh-hrc-runtime:lherron/hrc-runtime.git',
  sourceCommit: 'd22111938504f472d099f59136a60a0cd3264542',
  setName: hrc.setName,
  setVersion: '0.1.0-dev.20260828075353',
  builtAt: '2026-08-28T12:53:51.899Z',
}

describe('producer publish identity', () => {
  const canonicalHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  function gitSequence(results: Array<{ status: number; output: string }>): GitRunner {
    return () => results.shift() ?? { status: 2, output: 'unexpected git call' }
  }

  const contained: Array<{ status: number; output: string }> = [
    { status: 0, output: `${canonicalHead}\trefs/heads/main\n` },
    { status: 0, output: '' },
    { status: 0, output: '' },
    { status: 0, output: '' },
  ]

  test('accepts an alias-stamped tuple whose commit is contained by the table remote', async () => {
    await expect(
      assertPublishedProducerIdentity(build, hrc, gitSequence([...contained]))
    ).resolves.toBeUndefined()
  })

  test('refuses a same-path tuple whose commit is not contained by the table remote', async () => {
    await expect(
      assertPublishedProducerIdentity(
        { ...build, canonicalRemote: 'git@foreign-host:lherron/hrc-runtime.git' },
        hrc,
        gitSequence([...contained.slice(0, 3), { status: 1, output: '' }])
      )
    ).rejects.toThrow('producer source commit is not contained')
  })

  test('refuses when the table remote is unreachable', async () => {
    await expect(
      assertPublishedProducerIdentity(
        build,
        hrc,
        gitSequence([{ status: 128, output: 'ssh: Could not resolve hostname' }])
      )
    ).rejects.toThrow('canonical producer remote is unreachable')
  })

  test('refuses a repository mismatch without consulting the remote', async () => {
    await expect(
      assertPublishedProducerIdentity({ ...build, repository: 'foreign-runtime' }, hrc, () => {
        throw new Error('git must not run')
      })
    ).rejects.toThrow('wrong-repository producer tuple')
  })

  test('proves containment against the table remote, never the tuple remote', async () => {
    const calls: string[][] = []
    await assertPublishedProducerIdentity(build, hrc, (args) => {
      calls.push([...args])
      return contained[calls.length - 1] ?? { status: 2, output: 'unexpected git call' }
    })
    expect(calls[0]).toEqual(['ls-remote', hrc.canonicalRemote, 'refs/heads/main'])
    expect(calls[2]).toEqual(['fetch', '--quiet', hrc.canonicalRemote, canonicalHead])
    expect(calls[0]).not.toContain(build.canonicalRemote)
    expect(calls[2]).not.toContain(build.canonicalRemote)
  })
})

describe('post-advance consumer deployment', () => {
  test('judges coherence from the rewritten producer table on disk', async () => {
    const fixtureVersion = '0.1.0-dev.fixture-rewritten-table'
    expect(fixtureVersion).not.toBe(hrc.setVersion)

    const root = await mkdtemp(join(tmpdir(), 'acp-post-advance-'))
    try {
      const scriptsDir = join(root, 'scripts')
      const tableDir = join(root, 'packages/acp-server/src')
      await mkdir(scriptsDir, { recursive: true })
      await mkdir(tableDir, { recursive: true })
      await writeFile(
        join(tableDir, 'deployment-coherence.ts'),
        `export const EXPECTED_CONSUMER_PRODUCERS = [{ setName: 'hrc', setVersion: '${fixtureVersion}' }] as const\n`
      )
      await writeFile(
        join(scriptsDir, 'check-consumer-deployment-coherence.ts'),
        `import { EXPECTED_CONSUMER_PRODUCERS } from '../packages/acp-server/src/deployment-coherence.js'\nconst version = EXPECTED_CONSUMER_PRODUCERS.find((entry) => entry.setName === 'hrc')?.setVersion\nawait Bun.write('post-advance-readback.txt', version ?? 'missing')\nif (version !== '${fixtureVersion}') process.exit(1)\n`
      )

      assertPostAdvanceConsumerDeployment(root)

      expect(await readFile(join(root, 'post-advance-readback.txt'), 'utf8')).toBe(fixtureVersion)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('failed post-check restores the lock and relinks installed packages to it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-failed-advance-'))
    try {
      const oldPackage = join(root, 'fixtures/old-package')
      const newPackage = join(root, 'fixtures/new-package')
      await mkdir(oldPackage, { recursive: true })
      await mkdir(newPackage, { recursive: true })
      await writeFile(
        join(oldPackage, 'package.json'),
        JSON.stringify({ name: 'fixture-producer', version: '1.0.0' })
      )
      await writeFile(
        join(newPackage, 'package.json'),
        JSON.stringify({ name: 'fixture-producer', version: '2.0.0' })
      )

      const rootManifest = join(root, 'package.json')
      await writeFile(
        rootManifest,
        JSON.stringify({ dependencies: { 'fixture-producer': 'file:./fixtures/old-package' } })
      )
      expect(Bun.spawnSync(['bun', 'install'], { cwd: root }).exitCode).toBe(0)
      const snapshots = new Map([
        ['package.json', await readFile(rootManifest, 'utf8')],
        ['bun.lock', await readFile(join(root, 'bun.lock'), 'utf8')],
      ])

      await writeFile(
        rootManifest,
        JSON.stringify({ dependencies: { 'fixture-producer': 'file:./fixtures/new-package' } })
      )
      expect(Bun.spawnSync(['bun', 'install'], { cwd: root }).exitCode).toBe(0)
      expect(
        JSON.parse(await readFile(join(root, 'node_modules/fixture-producer/package.json'), 'utf8'))
          .version
      ).toBe('2.0.0')

      await restoreFailedProducerAdvance(snapshots, root)

      expect(await readFile(join(root, 'bun.lock'), 'utf8')).toBe(snapshots.get('bun.lock'))
      expect(
        JSON.parse(await readFile(join(root, 'node_modules/fixture-producer/package.json'), 'utf8'))
          .version
      ).toBe('1.0.0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
