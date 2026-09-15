import { describe, expect, test } from 'bun:test'
import { confineLockToSyncedPackages } from './lib/verdaccio-sync'

const entry = (key: string, resolution: string, info = '{}'): string =>
  `    ${JSON.stringify(key)}: [${JSON.stringify(resolution)}, "http://mini:4873/${key}.tgz", ${info}, "sha512-${resolution}"],`

const lock = (aspSpecifier: string, wrkqSpecifier: string, entries: readonly string[]): string =>
  `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "demo",
      "dependencies": {
        "agent-scope": ${JSON.stringify(aspSpecifier)},
        "@wrkq/client": ${JSON.stringify(wrkqSpecifier)},
      },
    },
  },
  "packages": {
${entries.join('\n\n')}
  }
}
`

describe('confining a producer advance to its derived member set', () => {
  test('a moving @wrkq/client selection remains byte-identical', () => {
    const beforeWrkq = entry('@wrkq/client', '@wrkq/client@1.0.0')
    const before = lock('1.0.0', 'latest', [beforeWrkq, entry('agent-scope', 'agent-scope@1.0.0')])
    const after = lock('2.0.0', 'latest', [
      entry('@wrkq/client', '@wrkq/client@9.9.9'),
      entry('agent-scope', 'agent-scope@2.0.0'),
    ])

    const confined = confineLockToSyncedPackages(before, after, new Set(['agent-scope']), '2.0.0')

    expect(confined).toContain(beforeWrkq)
    expect(confined).not.toContain('@wrkq/client@9.9.9')
    expect(confined).toContain('agent-scope@2.0.0')
    expect(confined).toContain('"agent-scope": "2.0.0"')
  })
})

describe('a non-member the lock is catching up to', () => {
  const before = lock('1.0.0', '1.0.0', [
    entry('@wrkq/client', '@wrkq/client@1.0.0'),
    entry('agent-scope', 'agent-scope@1.0.0'),
  ])
  const after = lock('2.0.0', '9.9.9', [
    entry('@wrkq/client', '@wrkq/client@9.9.9'),
    entry('agent-scope', 'agent-scope@2.0.0'),
  ])
  const synced = new Set(['agent-scope'])

  test('adopts the selection and specifier the manifests already declare', () => {
    const confined = confineLockToSyncedPackages(
      before,
      after,
      synced,
      '2.0.0',
      new Map([['@wrkq/client', new Set(['9.9.9'])]])
    )

    expect(confined).toContain('@wrkq/client@9.9.9')
    expect(confined).not.toContain('@wrkq/client@1.0.0')
    expect(confined).toContain('"@wrkq/client": "9.9.9"')
    expect(confined).toContain('agent-scope@2.0.0')
  })

  test('still pins a non-member the manifests do NOT declare at that version', () => {
    const confined = confineLockToSyncedPackages(
      before,
      after,
      synced,
      '2.0.0',
      new Map([['@wrkq/client', new Set(['8.8.8'])]])
    )

    expect(confined).toContain('@wrkq/client@1.0.0')
    expect(confined).not.toContain('@wrkq/client@9.9.9')
  })
})

describe('declarations that appeared or disappeared', () => {
  test('takes the head from the fresh resolution so added/removed pins survive', () => {
    const before = lock('1.0.0', 'latest', [entry('agent-scope', 'agent-scope@1.0.0')])
    const after = `{
  "workspaces": {
    "": {
      "dependencies": {
        "agent-scope": "2.0.0",
        "newly-added": "3.0.0",
      },
    },
  },
  "packages": {
${entry('agent-scope', 'agent-scope@2.0.0')}

${entry('newly-added', 'newly-added@3.0.0')}
  }
}
`
    const confined = confineLockToSyncedPackages(before, after, new Set(['agent-scope']), '2.0.0')

    expect(confined).toContain('"newly-added": "3.0.0"')
    expect(confined).not.toContain('"@wrkq/client"')
  })

  test('does not resurrect an entry the manifests no longer declare', () => {
    const before = lock('1.0.0', 'latest', [
      entry('agent-scope', 'agent-scope@1.0.0'),
      entry('orphan-pkg', 'orphan-pkg@1.0.0'),
    ])
    const after = lock('2.0.0', 'latest', [entry('agent-scope', 'agent-scope@2.0.0')])
    const declared = new Map([['agent-scope', new Set(['2.0.0'])]])

    const confined = confineLockToSyncedPackages(
      before,
      after,
      new Set(['agent-scope']),
      '2.0.0',
      declared
    )

    expect(confined).not.toContain('orphan-pkg@1.0.0')
  })

  test('keeps an undeclared entry when no declarations are supplied', () => {
    const before = lock('1.0.0', 'latest', [
      entry('agent-scope', 'agent-scope@1.0.0'),
      entry('orphan-pkg', 'orphan-pkg@1.0.0'),
    ])
    const after = lock('2.0.0', 'latest', [entry('agent-scope', 'agent-scope@2.0.0')])

    const confined = confineLockToSyncedPackages(before, after, new Set(['agent-scope']), '2.0.0')

    expect(confined).toContain('orphan-pkg@1.0.0')
  })
})
