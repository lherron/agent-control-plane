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
