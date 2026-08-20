import { describe, expect, test } from 'bun:test'
import { publishActionForVersion, timestampVersion } from './publish-local-verdaccio'

describe('publish-local-verdaccio channel versions', () => {
  test('uses a timestamped dev prerelease by default', () => {
    const version = timestampVersion('0.1.0', 'dev', new Date('2026-07-06T22:13:14Z'), 'ignored')

    expect(version).toBe('0.1.0-dev.20260706221314')
  })

  test('uses a worktree prerelease channel with timestamp and source short sha', () => {
    const version = timestampVersion(
      '0.1.0',
      'worktree',
      new Date('2026-07-06T22:13:14Z'),
      'abc123def456'
    )

    expect(version).toBe('0.1.0-worktree.20260706221314.abc123def456')
    expect(version).not.toContain('-dev.')
  })
})

describe('publish-local-verdaccio immutable versions', () => {
  test('refuses to replace an existing version unless force is explicit', () => {
    expect(() => publishActionForVersion('acp-core@0.1.0', true, false)).toThrow(
      'acp-core@0.1.0 already exists'
    )
    expect(publishActionForVersion('acp-core@0.1.0', true, true)).toBe('replace')
    expect(publishActionForVersion('acp-core@0.1.1-dev.1', false, false)).toBe('publish')
  })
})
