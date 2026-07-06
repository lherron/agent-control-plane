import { describe, expect, test } from 'bun:test'
import { timestampVersion } from './publish-local-verdaccio'

describe('publish-local-verdaccio worktree versions', () => {
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
