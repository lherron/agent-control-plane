import { describe, expect, it } from 'bun:test'

import { GhostmuxManager } from '../ghostmux'

/**
 * T-10484: every ghostmux exec forces a full scriptable-ghostty terminal list,
 * and reconcile repaints every pane. Identical presentation writes inside the
 * TTL must not reach ghostmux; anything that could have changed the surface
 * (a new value, a failed write, an expired TTL, a kill) must.
 */
function makeHarness(options: { failOn?: (args: string[]) => boolean } = {}) {
  const calls: string[][] = []
  let nowMs = 1_000_000
  const runner = async (args: string[]) => {
    calls.push(args)
    if (options.failOn?.(args)) throw new Error('ghostmux: transient socket failure')
    return { stdout: '{}', stderr: '' }
  }
  const manager = new GhostmuxManager('ghostmux', runner, undefined, undefined, {
    ttlMs: 60_000,
    now: () => nowMs,
  })
  return {
    manager,
    calls,
    advance: (ms: number) => {
      nowMs += ms
    },
    reset: () => {
      calls.length = 0
    },
  }
}

const bar = { left: 'CLOD', center: 'working', right: 'T-1', fg: '#fff', bg: '#000' }

async function paintAll(manager: GhostmuxManager, surfaceId: string, title = 'clod · T-1') {
  await manager.setHeadlessViewerTitle(surfaceId, title)
  await manager.setTerminalBackground(surfaceId, '#123456')
  await manager.setStatusBar(surfaceId, bar)
  await manager.setSecondaryStatusBar(surfaceId, { left: '', center: 'Task title', right: '' })
}

describe('GhostmuxManager presentation write dedupe (T-10484)', () => {
  it('skips an identical repaint inside the TTL', async () => {
    const h = makeHarness()
    await paintAll(h.manager, 's1')
    expect(h.calls.length).toBe(5)
    h.reset()
    await paintAll(h.manager, 's1')
    expect(h.calls).toEqual([])
  })

  it('writes a changed value, including a colour-only change', async () => {
    const h = makeHarness()
    await paintAll(h.manager, 's1')
    h.reset()
    await h.manager.setStatusBar('s1', { ...bar, fg: '#f00' })
    await h.manager.setHeadlessViewerTitle('s1', 'clod · T-2')
    expect(h.calls.map((c) => c[0])).toEqual(['statusbar', 'set-title'])
  })

  it('keeps surfaces independent', async () => {
    const h = makeHarness()
    await paintAll(h.manager, 's1')
    h.reset()
    await paintAll(h.manager, 's2')
    expect(h.calls.length).toBe(5)
  })

  it('retries after a failed write instead of remembering it', async () => {
    let fail = true
    const h = makeHarness({ failOn: (args) => fail && args[0] === 'set-bg' })
    await h.manager.setTerminalBackground('s1', '#123456')
    fail = false
    h.reset()
    await h.manager.setTerminalBackground('s1', '#123456')
    expect(h.calls.map((c) => c[0])).toEqual(['set-bg'])
  })

  it('rewrites once the TTL expires so drift is still repaired', async () => {
    const h = makeHarness()
    await paintAll(h.manager, 's1')
    h.advance(60_001)
    h.reset()
    await paintAll(h.manager, 's1')
    expect(h.calls.length).toBe(5)
  })

  it('forgets a terminated surface', async () => {
    const h = makeHarness()
    await paintAll(h.manager, 's1')
    await h.manager.terminate('s1')
    h.reset()
    await paintAll(h.manager, 's1')
    expect(h.calls.length).toBe(5)
  })

  it('alternating secondary hide and set always writes', async () => {
    const h = makeHarness()
    const spec = { left: '', center: 'Task title', right: '' }
    await h.manager.setSecondaryStatusBar('s1', spec)
    await h.manager.hideSecondaryStatusBar('s1')
    await h.manager.hideSecondaryStatusBar('s1')
    await h.manager.setSecondaryStatusBar('s1', spec)
    expect(h.calls.map((c) => c.slice(0, 2).concat(c.includes('hide') ? 'hide' : []))).toEqual([
      ['statusbar', 'set'],
      ['statusbar', 'show'],
      ['statusbar', 'hide', 'hide'],
      ['statusbar', 'set'],
      ['statusbar', 'show'],
    ])
  })

  it('a pane create/rebind title write is recorded, so restoring the old title is not skipped', async () => {
    const h = makeHarness()
    await h.manager.setHeadlessViewerTitle('s1', 'old')
    // ensureHeadlessViewer stamps the pane title directly on rebind.
    await h.manager.stampPaneTitle('s1', 'pane-title')
    h.reset()
    await h.manager.setHeadlessViewerTitle('s1', 'old')
    expect(h.calls.map((c) => c[0])).toEqual(['set-title'])
  })
})
