import { describe, expect, test } from 'bun:test'
import { computeInstallPolicy, detectContextFromGitDirs } from './install-policy'

describe('install policy', () => {
  test('detects the primary checkout when git dir and common git dir match', () => {
    expect(detectContextFromGitDirs('/repo', '.git', '.git')).toBe('main')
  })

  test('detects a linked worktree when git dir lives under the common dir worktrees area', () => {
    expect(
      detectContextFromGitDirs('/repo/worktree', '/repo/.git/worktrees/acp-T-05830', '/repo/.git')
    ).toBe('linked-worktree')
  })

  test('keeps main checkout publish and wrapper side effects enabled by default', () => {
    expect(computeInstallPolicy({ context: 'main' })).toEqual({
      context: 'main',
      syncMode: 'on',
      linkMode: 'on',
      publishChannel: 'dev',
      publishTag: 'latest',
    })
  })

  test('turns wrapper linking and sync side effects off in linked worktrees by default', () => {
    expect(computeInstallPolicy({ context: 'linked-worktree' })).toEqual({
      context: 'linked-worktree',
      syncMode: 'off',
      linkMode: 'off',
      publishChannel: 'worktree',
      publishTag: 'worktree',
    })
  })

  test('allows no-sync from the main checkout', () => {
    expect(computeInstallPolicy({ context: 'main', noSync: '1' }).syncMode).toBe('off')
  })

  test('allows loud force options from a linked worktree', () => {
    expect(
      computeInstallPolicy({ context: 'linked-worktree', forceSync: '1', forceLink: 'true' })
    ).toMatchObject({
      syncMode: 'forced',
      linkMode: 'forced',
    })
  })

  test('rejects contradictory sync controls', () => {
    expect(() =>
      computeInstallPolicy({ context: 'linked-worktree', noSync: '1', forceSync: '1' })
    ).toThrow(/no-sync and force-sync/)
  })
})
