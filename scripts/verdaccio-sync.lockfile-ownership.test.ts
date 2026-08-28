import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'lib', 'verdaccio-sync.ts'), 'utf8')

// T-07629: a producer repo's `just install` drives this sync in every consumer.
// It must never write git history in a consumer repo. Pulls leave reviewable diffs.
describe('verdaccio sync lockfile ownership', () => {
  test('syncFromVerdaccio never commits', () => {
    const sync = source.slice(source.indexOf('export async function syncFromVerdaccio'))
    expect(sync).not.toBe('')
    expect(sync).not.toContain('commitLockfile')
    expect(sync).toContain('announceDirtyLockfile(spec.label)')
  })

  test('no sync helper runs git commit', () => {
    expect(source).not.toContain("'commit',")
    expect(source).not.toContain('commitLockfile')
  })

  test('the commit is not merely flagged off', () => {
    expect(source).not.toContain('PRAESIDIUM_SYNC_NO_COMMIT')
  })
})
