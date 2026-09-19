import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ExpectedConsumerProducer,
  evaluateConsumerDeployment,
} from '../packages/acp-server/src/deployment-coherence.js'
import {
  lockedPackageVersions,
  pruneUnselectedRootPackageDirs,
  pruneUnselectedRootStoreVersions,
} from './lib/verdaccio-sync.js'

const OLD = '0.1.0-dev.20260915135010'
const NEW = '0.1.0-dev.20260917141337'
const COMMIT = 'e902f89c89c8207b475400fb8b3bedd9948f2745'

const entry = (key: string, resolution: string): string =>
  `    ${JSON.stringify(key)}: [${JSON.stringify(resolution)}, "http://mini:4873/hrc-sdk/-/hrc-sdk-${NEW}.tgz", {}, "sha512-hJfIUhA7x5rQ4cT0vK2uN4mL6pP8sS0tT2uU4vV6wW8xX0yY2zZ4aA6bB8cC0dD2eE4fF6gG8="],`

const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "demo",
      "dependencies": {
        "hrc-sdk": ${JSON.stringify(NEW)},
      },
    },
  },
  "packages": {
${entry('hrc-sdk', `hrc-sdk@${NEW}`)}
  }
}
`

const expected: readonly ExpectedConsumerProducer[] = [
  {
    setName: 'hrc',
    setVersion: NEW,
    repository: 'hrc-runtime',
    canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
    sourceCommit: COMMIT,
  },
]

function manifest(version: string): string {
  return JSON.stringify({
    name: 'hrc-sdk',
    version,
    praesidiumBuild: {
      schema: 1,
      repository: 'hrc-runtime',
      canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
      sourceCommit: COMMIT,
      setName: 'hrc',
      setVersion: version,
      builtAt: '2026-09-17T19:13:35.706Z',
    },
  })
}

async function seedStore(root: string): Promise<void> {
  for (const [dir, body] of [
    [`hrc-sdk@${OLD}`, manifest(OLD)],
    [`hrc-sdk@${NEW}`, manifest(NEW)],
    ['left-pad@9.9.9', JSON.stringify({ name: 'left-pad', version: '9.9.9' })],
  ] as const) {
    const name = dir.split('@')[0] as string
    const target = join(root, 'node_modules', '.bun', dir, 'node_modules', name)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), body)
  }
}

async function installedFromStore(root: string) {
  const store = join(root, 'node_modules', '.bun')
  const { readdir } = await import('node:fs/promises')
  const installed = []
  for (const dir of await readdir(store)) {
    const name = dir.startsWith('@') ? undefined : (dir.split('@')[0] as string)
    if (name === undefined) continue
    const manifestPath = join(store, dir, 'node_modules', name, 'package.json')
    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (raw?.praesidiumBuild?.setName === undefined) continue
      installed.push({
        lockKey: name,
        manifestPath,
        name,
        version: raw.version ?? '',
        praesidiumBuild: raw.praesidiumBuild,
      })
    } catch {
      // unreadable manifest; skip
    }
  }
  return installed
}

describe('pruning unselected root-store versions on producer advance (T-08572 H3)', () => {
  test('an orphaned old-version store dir fails coherence before, passes after the prune', async () => {
    const root = await mkdtemp(join(tmpdir(), 'root-store-prune-'))
    try {
      await seedStore(root)
      const synced = new Set(['hrc-sdk'])
      expect(lockedPackageVersions(lockText).get('hrc-sdk')).toEqual(new Set([NEW]))

      const before = await installedFromStore(root)
      expect(evaluateConsumerDeployment({ lockText, installed: before }, expected).ok).toBe(false)

      const removed = await pruneUnselectedRootStoreVersions({ root, synced, lockText })
      expect(removed).toEqual([`hrc-sdk@${OLD}`])

      const after = await installedFromStore(root)
      const manifests = [
        { path: 'package.json', overrides: { 'hrc-sdk': NEW } },
        { path: 'packages/demo/package.json', dependencies: { 'hrc-sdk': NEW } },
      ]
      const report = evaluateConsumerDeployment({ lockText, installed: after, manifests }, expected)
      expect(report.findings).toEqual([])
      expect(report.ok).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the selected version, unlisted members and third-party dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'root-store-prune-'))
    try {
      await seedStore(root)
      const { readdir } = await import('node:fs/promises')
      const store = join(root, 'node_modules', '.bun')
      await pruneUnselectedRootStoreVersions({ root, synced: new Set(['hrc-sdk']), lockText })
      const remaining = (await readdir(store)).sort()
      expect(remaining).toEqual([`hrc-sdk@${NEW}`, 'left-pad@9.9.9'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('removes a producer store dir absent from the confined lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'root-store-prune-'))
    try {
      await seedStore(root)
      const absent = lockText.replace(`${entry('hrc-sdk', `hrc-sdk@${NEW}`)}\n`, '')
      const removed = await pruneUnselectedRootStoreVersions({
        root,
        synced: new Set(['hrc-sdk']),
        lockText: absent,
      })
      expect(removed.sort()).toEqual([`hrc-sdk@${OLD}`, `hrc-sdk@${NEW}`])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('removes a direct root producer copy absent from the confined lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'root-package-prune-'))
    try {
      const stale = join(root, 'node_modules', 'hrc-sdk')
      await mkdir(stale, { recursive: true })
      await writeFile(join(stale, 'package.json'), manifest(OLD))
      const absent = lockText.replace(`${entry('hrc-sdk', `hrc-sdk@${NEW}`)}\n`, '')
      expect(
        await pruneUnselectedRootPackageDirs({
          root,
          synced: new Set(['hrc-sdk']),
          lockText: absent,
        })
      ).toEqual(['hrc-sdk'])
      expect(await Bun.file(join(stale, 'package.json')).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
