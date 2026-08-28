import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('the sync install sequence', () => {
  const source = readFileSync(join(import.meta.dir, 'lib', 'verdaccio-sync.ts'), 'utf8')
  const sync = source.slice(source.indexOf('export async function syncFromVerdaccio'))

  test('confines and relinks frozen', () => {
    expect(sync).toContain('installConfinedPackages({')
    expect(sync).toContain('beforeRelink: async () =>')
    expect(source).toContain("mode === 'relink' ? '--frozen-lockfile' : '--no-cache'")
  })
})
