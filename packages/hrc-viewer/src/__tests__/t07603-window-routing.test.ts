import { fixtureIdentity } from './session-identity-fixture.js'
/**
 * T-07603 — route viewer tabs by scope shape, adopt the interactive window.
 *
 * Under T-07118 the window came from an operator-applied `hrc_window_key` stamp,
 * and an absent hint always meant the headless window. Both change here:
 *
 *  - placement is derived from the scope's SHAPE (`T-XXXXX` is background work,
 *    everything the operator named is foreground),
 *  - the interactive window is ADOPTED from what is already open rather than
 *    stamped by hand, so it survives Ghostty restarts wiping window metadata.
 *
 * The reap-safety case is the one that earns its keep: HRC now creates and kills
 * panes inside a window the operator personally uses.
 */

import { describe, expect, it } from 'bun:test'

import {
  CHIEF_WINDOW_KEY,
  DEFAULT_HEADLESS_WINDOW_KEY,
  GhostmuxManager,
  INTERACTIVE_WINDOW_KEY,
  defaultWindowKeyForTab,
  deriveHeadlessTabIdentity,
} from '../ghostmux'

describe('T-07603 scope-shape routing', () => {
  it('sends an UNPARSEABLE scope to the headless window, never the operator’s', () => {
    // `deriveHeadlessTabIdentity` returns before `isRealTaskId` for a scope it
    // cannot parse, so keying off a bare taskId would land junk in the operator's
    // window. Malformed input belongs in the background pile.
    const tab = deriveHeadlessTabIdentity(
      'this is not a scope ref',
      fixtureIdentity('this is not a scope ref')
    )
    expect(tab.tabKey.startsWith('unparsed:')).toBe(true)
    expect(defaultWindowKeyForTab(tab)).toBe(DEFAULT_HEADLESS_WINDOW_KEY)
  })
})

type Win = { metadata: Record<string, unknown>; seq: number }
type Surf = { windowId: string; meta: Record<string, unknown>; title?: string | undefined }

/** Minimal windows-API fake: enough to exercise adoption and reap fencing. */
function makeFake() {
  const windows = new Map<string, Win>()
  const surfaces = new Map<string, Surf>()
  const calls: string[][] = []
  let seq = 0
  const argAfter = (args: string[], flag: string) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const allocWindow = (metadata: Record<string, unknown> = {}) => {
    seq += 1
    const id = `win-${seq}`
    windows.set(id, { metadata, seq })
    return id
  }
  const allocSurface = (windowId: string, meta: Record<string, unknown> = {}) => {
    seq += 1
    const id = `surf-${seq}`
    surfaces.set(id, { windowId, meta })
    return id
  }
  const runner = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'list-windows') {
      const filters = args
        .map((arg, index) => (arg === '--meta' ? args[index + 1] : undefined))
        .filter((pair): pair is string => pair !== undefined)
        .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
      const matching = [...windows.entries()]
        .sort((a, b) => a[1].seq - b[1].seq)
        .filter(([, w]) => filters.every(([k, v]) => w.metadata[k ?? ''] === v))
      return {
        stdout: JSON.stringify({
          windows: matching.map(([id, w]) => ({ id, metadata: w.metadata, terminal_ids: [] })),
        }),
        stderr: '',
      }
    }
    if (args[0] === 'metadata') {
      const windowId = argAfter(args, '--window-id')
      const json = args.slice(2).find((a) => a.trim().startsWith('{')) ?? '{}'
      if (windowId !== undefined) {
        const window = windows.get(windowId)
        if (window) window.metadata = { ...window.metadata, ...JSON.parse(json) }
        return { stdout: '{}', stderr: '' }
      }
      const surface = surfaces.get(argAfter(args, '-t') ?? '')
      if (args[1] === 'set') {
        if (surface) surface.meta = { ...surface.meta, ...JSON.parse(json) }
        return { stdout: '{}', stderr: '' }
      }
      return { stdout: JSON.stringify({ data: surface?.meta ?? {} }), stderr: '' }
    }
    if (args[0] === 'new' && args.includes('--window')) {
      const findBy = JSON.parse(argAfter(args, '--find-or-create-by') ?? '{}')
      const meta = JSON.parse(argAfter(args, '--metadata') ?? '{}')
      const hit = [...windows.entries()]
        .sort((a, b) => a[1].seq - b[1].seq)
        .find(([, w]) => Object.entries(findBy).every(([k, v]) => w.metadata[k] === v))
      if (hit) return { stdout: JSON.stringify({ id: hit[0], created: false }), stderr: '' }
      const id = allocWindow({ ...meta, ...findBy })
      return { stdout: JSON.stringify({ id, created: true }), stderr: '' }
    }
    if (args[0] === 'new') {
      const id = allocSurface(argAfter(args, '--window-id') ?? 'win-0')
      return { stdout: JSON.stringify({ id, window_id: surfaces.get(id)?.windowId }), stderr: '' }
    }
    if (args[0] === 'new-pane') {
      // Split: the new pane lands in the same window as its split target.
      const target = surfaces.get(argAfter(args, '-t') ?? '')
      const id = allocSurface(target?.windowId ?? 'win-0')
      return { stdout: JSON.stringify({ id, window_id: surfaces.get(id)?.windowId }), stderr: '' }
    }
    if (args[0] === 'list-surfaces') {
      return {
        stdout: JSON.stringify({
          terminals: [...surfaces.entries()].map(([id, s]) => ({
            id,
            window_id: s.windowId,
            columns: 120,
            rows: 40,
          })),
        }),
        stderr: '',
      }
    }
    if (args[0] === 'kill-surface') {
      surfaces.delete(argAfter(args, '-t') ?? '')
      return { stdout: '{}', stderr: '' }
    }
    return { stdout: '{}', stderr: '' }
  }
  return { runner, calls, windows, surfaces, allocWindow, allocSurface }
}

const PRIMARY = 'agent:clod:project:hrc-runtime:task:primary'

describe('T-07603 interactive-window adoption', () => {
  it.each([
    ['agent:cody:project:hcs:task:T-12345', undefined, CHIEF_WINDOW_KEY],
    ['agent:chief:project:hcs:task:T-12345', undefined, CHIEF_WINDOW_KEY],
    ['agent:chief:project:hcs:task:primary', undefined, CHIEF_WINDOW_KEY],
    ['agent:cody:project:hrc-runtime:task:T-12345', undefined, DEFAULT_HEADLESS_WINDOW_KEY],
    ['agent:cody:project:hrc-runtime:task:T-07595', undefined, DEFAULT_HEADLESS_WINDOW_KEY],
    [
      'agent:clod:project:hrc-runtime:task:T-07595:role:p3-prod-run',
      undefined,
      DEFAULT_HEADLESS_WINDOW_KEY,
    ],
    ['agent:mable:project:hcs:task:primary', undefined, INTERACTIVE_WINDOW_KEY],
    ...['primary', 'primary-nova', 'minisvc', 'minilab', 'viewrca'].map(
      (slot) =>
        [`agent:clod:project:hrc-runtime:task:${slot}`, undefined, INTERACTIVE_WINDOW_KEY] as const
    ),
    ['this is not a scope ref', undefined, DEFAULT_HEADLESS_WINDOW_KEY],
    ['agent:cody:project:hcs:task:T-12345', 'console', INTERACTIVE_WINDOW_KEY],
    ['agent:cody:project:hrc-runtime:task:T-07595', 'console', INTERACTIVE_WINDOW_KEY],
    ['agent:clod:project:hrc-runtime:task:primary', 'default', DEFAULT_HEADLESS_WINDOW_KEY],
    ['agent:clod:project:hrc-runtime:task:primary', '   ', INTERACTIVE_WINDOW_KEY],
  ] as const)(
    'places scope %s with hint %s in window %s',
    async (scopeRef, windowKey, expected) => {
      const fake = makeFake()
      const manager = new GhostmuxManager('ghostmux', fake.runner)
      await manager.ensureHeadlessViewer({
        identity: fixtureIdentity(scopeRef),
        scopeRef,
        runtimeId: 'rt-test',
        attachCommand: 'a',
        ...(windowKey !== undefined ? { windowKey } : {}),
      })
      expect(
        [...fake.windows.values()].some((window) => window.metadata['hrc_window_key'] === expected)
      ).toBe(true)
      const windowCreate = fake.calls.find((args) => args[0] === 'new' && args.includes('--window'))
      const title =
        expected === CHIEF_WINDOW_KEY
          ? 'Chief Contexts'
          : expected === INTERACTIVE_WINDOW_KEY
            ? 'Headless Sessions · console'
            : 'Headless Sessions'
      expect(windowCreate?.[windowCreate.indexOf('--title') + 1]).toBe(title)
    }
  )

  it('adopts the OLDEST untagged window and stamps it', async () => {
    const fake = makeFake()
    const oldest = fake.allocWindow()
    fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(PRIMARY),
      scopeRef: PRIMARY,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })

    expect(fake.windows.get(oldest)?.metadata).toMatchObject({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: INTERACTIVE_WINDOW_KEY,
    })
    // Adopted, not created: still exactly the two windows we started with.
    expect(fake.windows.size).toBe(2)
  })

  it('never adopts a window already tagged for the headless pile', async () => {
    const fake = makeFake()
    const headless = fake.allocWindow({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: DEFAULT_HEADLESS_WINDOW_KEY,
    })
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(PRIMARY),
      scopeRef: PRIMARY,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })

    expect(fake.windows.get(headless)?.metadata['hrc_window_key']).toBe(DEFAULT_HEADLESS_WINDOW_KEY)
    // No untagged candidate ⇒ a fresh interactive window was created instead.
    expect(fake.windows.size).toBe(2)
  })

  it('creates an interactive window when nothing is open at all', async () => {
    const fake = makeFake()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(PRIMARY),
      scopeRef: PRIMARY,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })

    expect(fake.windows.size).toBe(1)
    expect([...fake.windows.values()][0]?.metadata['hrc_window_key']).toBe(INTERACTIVE_WINDOW_KEY)
  })

  it('reuses the adopted window on later placements without re-scanning', async () => {
    const fake = makeFake()
    fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(PRIMARY),
      scopeRef: PRIMARY,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })
    const scansAfterFirst = fake.calls.filter(
      (c) => c[0] === 'list-windows' && !c.includes('--meta')
    ).length

    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity('agent:mable:project:hrc-runtime:task:primary'),
      scopeRef: 'agent:mable:project:hrc-runtime:task:primary',
      runtimeId: 'rt-2',
      attachCommand: 'b',
    })

    // Steady state is the `--meta` filtered read alone; no further full scan.
    expect(fake.calls.filter((c) => c[0] === 'list-windows' && !c.includes('--meta')).length).toBe(
      scansAfterFirst
    )
    expect(fake.windows.size).toBe(1)
  })
})

describe('T-07930 non-interactive keyed-window isolation', () => {
  it('creates a dedicated chief window without stamping the operator window', async () => {
    const fake = makeFake()
    const operatorWindow = fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      identity: fixtureIdentity('agent:chief:project:hcs:task:T-07930'),
      scopeRef: 'agent:chief:project:hcs:task:T-07930',
      runtimeId: 'rt-chief',
      attachCommand: 'a',
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`)
    expect(fake.windows.get(operatorWindow)?.metadata).toEqual({})
    expect(fake.windows.size).toBe(2)

    const chiefWindow = [...fake.windows.entries()].find(
      ([, window]) => window.metadata['hrc_window_key'] === CHIEF_WINDOW_KEY
    )
    expect(chiefWindow?.[1].metadata).toMatchObject({
      hrc_role: 'headless-sessions-window',
      hrc_window_key: CHIEF_WINDOW_KEY,
    })
    expect(fake.surfaces.get(result.surfaceId)?.windowId).toBe(chiefWindow?.[0])
  })

  it('creates a custom keyed window without adopting the operator window', async () => {
    const fake = makeFake()
    const operatorWindow = fake.allocWindow()
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    const result = await manager.ensureHeadlessViewer({
      identity: fixtureIdentity('agent:cody:project:hrc-runtime:task:T-07930'),
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-07930',
      runtimeId: 'rt-custom',
      attachCommand: 'a',
      windowKey: 'review',
    })

    expect(result.status).toBe('created')
    if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`)
    expect(fake.windows.get(operatorWindow)?.metadata).toEqual({})
    expect(fake.windows.size).toBe(2)

    const customWindow = [...fake.windows.entries()].find(
      ([, window]) => window.metadata['hrc_window_key'] === 'review'
    )
    expect(fake.surfaces.get(result.surfaceId)?.windowId).toBe(customWindow?.[0])
  })
})

describe('T-07603 reap safety inside an adopted operator window', () => {
  it('refuses to reap a surface the operator owns', async () => {
    const fake = makeFake()
    const operatorWindow = fake.allocWindow()
    // A tab Lance opened himself: no HRC metadata of any kind.
    const operatorTab = fake.allocSurface(operatorWindow, {})
    const manager = new GhostmuxManager('ghostmux', fake.runner)

    await manager.ensureHeadlessViewer({
      identity: fixtureIdentity(PRIMARY),
      scopeRef: PRIMARY,
      runtimeId: 'rt-1',
      attachCommand: 'a',
    })
    expect(fake.windows.get(operatorWindow)?.metadata['hrc_window_key']).toBe(
      INTERACTIVE_WINDOW_KEY
    )

    // The reap path is metadata-fenced: an operator tab is not an agent pane, so
    // it survives even though HRC now owns the window it lives in.
    expect(await manager.reapHeadlessAgentPane(operatorTab, 'rt-1')).toMatchObject({
      status: 'skipped',
      reason: 'not_agent_pane',
    })
    expect(fake.surfaces.has(operatorTab)).toBe(true)
  })
})
