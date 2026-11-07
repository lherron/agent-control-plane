import { describe, expect, it } from 'bun:test'
import { fixtureIdentity } from './session-identity-fixture.js'

import { GhostmuxManager } from '../ghostmux'

import { makeFakeGhostmux } from './ghostmux-metadata-fixture.js'

describe('GhostmuxManager.reapHeadlessAgentPane (runtime-fenced, daedalus C4)', () => {
  const cloRef = 'agent:clod:project:hrc-runtime:task:T-05237'
  const curlyRef = 'agent:curly:project:hrc-runtime:task:T-05237'

  it('reaps the pane bound to the terminating runtime and reports tab collapse', async () => {
    const fake = makeFakeGhostmux('error')
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(cloRef),
      scopeRef: cloRef,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })
    const paneId = fake.agentPanes()[0]?.[0] ?? ''

    const result = await manager.reapHeadlessAgentPane(paneId, 'rt-1')
    expect(result).toEqual({ status: 'reaped', surfaceId: paneId, tabCollapsed: true })
    expect(fake.liveIds()).not.toContain(paneId)
  })

  it('does NOT collapse the tab while a sibling agent pane survives', async () => {
    const fake = makeFakeGhostmux('error')
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(cloRef),
      scopeRef: cloRef,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })
    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(curlyRef),
      scopeRef: curlyRef,
      runtimeId: 'rt-2',
      attachCommand: 'b',
    })
    const cloPane =
      fake.agentPanes().find(([, s]) => s.surfaceMeta['hrc_agent_id'] === 'clod')?.[0] ?? ''

    const result = await manager.reapHeadlessAgentPane(cloPane, 'rt-1')
    expect(result).toEqual({ status: 'reaped', surfaceId: cloPane, tabCollapsed: false })
    expect(fake.agentPanes()).toHaveLength(1)
  })

  it('FENCE: refuses to reap a pane already rebound to a newer runtime', async () => {
    const fake = makeFakeGhostmux('error')
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(cloRef),
      scopeRef: cloRef,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })
    const paneId = fake.agentPanes()[0]?.[0] ?? ''
    // Reuse rebinds to rt-2.
    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(cloRef),
      scopeRef: cloRef,
      runtimeId: 'rt-2',
      attachCommand: 'a2',
    })

    // A stale terminal event for rt-1 must NOT kill the pane.
    const result = await manager.reapHeadlessAgentPane(paneId, 'rt-1')
    expect(result).toEqual({
      status: 'skipped',
      reason: 'runtime_rebound',
      observedRuntimeId: 'rt-2',
      requiredRuntimeId: 'rt-1',
    })
    expect(fake.liveIds()).toContain(paneId)
  })

  it('never kills the window anchor', async () => {
    const fake = makeFakeGhostmux('error')
    const manager = new GhostmuxManager('ghostmux', fake.runner)
    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(cloRef),
      scopeRef: cloRef,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })
    const anchorId = fake.anchors()[0]?.[0] ?? ''

    const result = await manager.reapHeadlessAgentPane(anchorId, 'rt-1')
    expect(result).toEqual({
      status: 'skipped',
      reason: 'not_agent_pane',
      observedRole: 'headless-window-anchor',
      requiredRole: 'headless-agent-pane',
    })
    expect(fake.liveIds()).toContain(anchorId)
  })
})

describe('GhostmuxManager.setStatusBar', () => {
  it('emits the canonical statusbar set argv', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.setStatusBar('surf-1', {
      left: '◆ CODY',
      center: 'wrkq · T-1',
      right: '✓ idle',
      fg: '#F2EEE6',
      bg: '#1F7A78',
    })

    expect(calls).toEqual([
      [
        'statusbar',
        'set',
        '-t',
        'surf-1',
        '◆ CODY|wrkq · T-1|✓ idle',
        '--fg',
        '#F2EEE6',
        '--bg',
        '#1F7A78',
      ],
    ])
  })

  it('sanitizes pipe/newline characters out of fields', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.setStatusBar('surf-1', {
      left: 'a|b',
      center: 'c\nd',
      right: 'e',
    })

    expect(calls[0]?.[4]).toBe('a b|c d|e')
  })

  it('swallows failures and never throws', async () => {
    const manager = new GhostmuxManager('ghostmux', async () => {
      throw new Error('transient surface error')
    })
    await expect(
      manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })
    ).resolves.toBeUndefined()
  })

  it('memoizes an unsupported-statusbar capability and stops calling ghostmux', async () => {
    let count = 0
    const manager = new GhostmuxManager('ghostmux', async () => {
      count++
      throw new Error('error: unknown command "statusbar"')
    })

    await manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })
    await manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })

    expect(count).toBe(1)
  })
})

describe('GhostmuxManager.setTerminalBackground', () => {
  it('emits the set-bg argv', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })
    await manager.setTerminalBackground('surf-1', '#241B36')
    expect(calls).toEqual([['set-bg', '-t', 'surf-1', '#241B36', '--json']])
  })

  it('swallows failures and never throws', async () => {
    const manager = new GhostmuxManager('ghostmux', async () => {
      throw new Error('no such surface')
    })
    await expect(manager.setTerminalBackground('surf-1', '#241B36')).resolves.toBeUndefined()
  })

  it('memoizes set-bg unsupported SEPARATELY from statusbar', async () => {
    let setBgCalls = 0
    let statusBarCalls = 0
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      if (args[0] === 'set-bg') {
        setBgCalls++
        throw new Error('error: unknown command "set-bg"')
      }
      statusBarCalls++
      return { stdout: '{}', stderr: '' }
    })

    await manager.setTerminalBackground('surf-1', '#241B36')
    await manager.setTerminalBackground('surf-1', '#241B36')
    // set-bg memoized off after the first failure
    expect(setBgCalls).toBe(1)
    // statusbar capability is unaffected by the set-bg memo
    await manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })
    expect(statusBarCalls).toBe(1)
  })
})

/**
 * T-08331 — the SECONDARY slot. Its argv, its wire sanitizing and its capability
 * memo are all distinct from the primary bar's, and the difference is load-
 * bearing: hcs stamps this same slot on its own context panes until T-08332
 * removes that writer, so any divergence renders as a flapping bar.
 */
describe('GhostmuxManager.setSecondaryStatusBar', () => {
  it('sets then SHOWS — a set alone renders nothing, the slot defaults to hidden', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.setSecondaryStatusBar('surf-1', {
      left: '▸ hrc-viewer should populate second status bar',
      center: '',
      right: '',
    })

    expect(calls).toEqual([
      [
        'statusbar',
        'set',
        '-t',
        'surf-1',
        '--bar',
        'secondary',
        '▸ hrc-viewer should populate second status bar||',
      ],
      ['statusbar', 'show', '-t', 'surf-1', '--bar', 'secondary'],
    ])
  })

  it('sanitizes exactly as hcs does: `|` becomes `/`, not a space', async () => {
    // The PRIMARY rule maps `|` to a space. Matching hcs's `statusBarField`
    // byte for byte is what makes the two writers overlap invisibly.
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.setSecondaryStatusBar('surf-1', {
      left: '  ▸ a|b\tc\nd  ',
      center: '',
      right: '',
    })

    expect(calls[0]?.[6]).toBe('▸ a/b c d||')
  })

  it('hide emits the secondary-scoped hide argv', async () => {
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      return { stdout: '{}', stderr: '' }
    })

    await manager.hideSecondaryStatusBar('surf-1')

    expect(calls).toEqual([['statusbar', 'hide', '-t', 'surf-1', '--bar', 'secondary']])
  })

  it('swallows failures and never throws', async () => {
    const manager = new GhostmuxManager('ghostmux', async () => {
      throw new Error('transient surface error')
    })
    await expect(
      manager.setSecondaryStatusBar('surf-1', { left: 'a', center: '', right: '' })
    ).resolves.toBeUndefined()
    await expect(manager.hideSecondaryStatusBar('surf-1')).resolves.toBeUndefined()
  })

  it('an unsupported secondary slot memoizes OFF without disabling the primary bar', async () => {
    // ghostmux refuses rather than falling back to the primary bar, so this is
    // a capability answer. A shared memo would take the primary down with it.
    const calls: string[][] = []
    const manager = new GhostmuxManager('ghostmux', async (args) => {
      calls.push(args)
      if (args.includes('secondary')) throw new Error('unsupported status bar slot: secondary')
      return { stdout: '{}', stderr: '' }
    })

    await manager.setSecondaryStatusBar('surf-1', { left: 'a', center: '', right: '' })
    await manager.setSecondaryStatusBar('surf-1', { left: 'a', center: '', right: '' })
    await manager.hideSecondaryStatusBar('surf-1')
    expect(calls.filter((args) => args.includes('secondary'))).toHaveLength(1)

    await manager.setStatusBar('surf-1', { left: 'a', center: 'b', right: 'c' })
    expect(calls.some((args) => args[0] === 'statusbar' && !args.includes('secondary'))).toBe(true)
  })
})
