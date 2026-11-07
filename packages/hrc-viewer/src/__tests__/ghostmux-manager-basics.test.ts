import { describe, expect, it } from 'bun:test'
import { fixtureIdentity } from './session-identity-fixture.js'

import { parseGhostmuxSurfaceState } from '../ghostmux-client'
import { deriveHeadlessSessionIdentity, deriveHeadlessTabIdentity } from '../ghostmux-identity'

describe('parseGhostmuxSurfaceState', () => {
  it('parses list/new style terminal JSON', () => {
    const state = parseGhostmuxSurfaceState(
      JSON.stringify({
        id: 'surface-1',
        short_id: 'surface',
        name: 'calm-field',
        title: 'Claude Surfaces',
        working_directory: '/tmp/project',
        rows: 40,
        columns: 120,
        focused: true,
      })
    )

    expect(state).toEqual({
      kind: 'ghostty',
      surfaceId: 'surface-1',
      shortId: 'surface',
      name: 'calm-field',
      title: 'Claude Surfaces',
      cwd: '/tmp/project',
      rows: 40,
      columns: 120,
      focused: true,
      createdBy: 'ghostmux',
    })
  })
})

// ---------------------------------------------------------------------------
// T-05237: canonical tab-key derivation (daedalus required test #1)
// ---------------------------------------------------------------------------
describe('deriveHeadlessTabIdentity', () => {
  it('maps a real task scope to task:<T-XXXXX>', () => {
    const id = deriveHeadlessTabIdentity(
      'agent:clod:project:hrc-runtime:task:T-05237',
      fixtureIdentity('agent:clod:project:hrc-runtime:task:T-05237')
    )
    expect(id).toEqual({
      tabKey: 'task:T-05237',
      agentId: 'clod',
      taskId: 'T-05237',
      projectId: 'hrc-runtime',
      label: 'hrc · T-05237',
    })
  })

  it('keys a subtask scope by its full subtask id, not its owner (T-09895)', () => {
    const id = deriveHeadlessTabIdentity(
      'agent:clod:project:hrc-runtime:task:T-05237.render-preview',
      fixtureIdentity('agent:clod:project:hrc-runtime:task:T-05237.render-preview')
    )
    expect(id).toEqual({
      tabKey: 'task:T-05237.render-preview',
      agentId: 'clod',
      taskId: 'T-05237.render-preview',
      projectId: 'hrc-runtime',
      label: 'hrc · T-05237.render-preview',
    })
  })

  it('does not treat a task-shaped token outside the grammar as a task (T-09895)', () => {
    const id = deriveHeadlessTabIdentity(
      'agent:clod:project:hrc-runtime:task:T-05237-extra',
      fixtureIdentity('agent:clod:project:hrc-runtime:task:T-05237-extra')
    )
    expect(id.tabKey).toBe('project:hrc-runtime:T-05237-extra')
    expect(id.taskId).toBeUndefined()
  })

  it('maps a primary scope to a project-qualified key (never bare primary)', () => {
    const id = deriveHeadlessTabIdentity(
      'agent:clod:project:hrc-runtime:task:primary',
      fixtureIdentity('agent:clod:project:hrc-runtime:task:primary')
    )
    expect(id.tabKey).toBe('project:hrc-runtime:primary')
    expect(id.agentId).toBe('clod')
    expect(id.label).toBe('hrc · primary')
  })

  it('gives a named non-task scope (roster slot) its OWN tab key (T-07142)', () => {
    const nova = deriveHeadlessTabIdentity(
      'agent:mable:project:hrc-runtime:task:primary-nova',
      fixtureIdentity('agent:mable:project:hrc-runtime:task:primary-nova')
    )
    expect(nova.tabKey).toBe('project:hrc-runtime:primary-nova')
    expect(nova.label).toBe('hrc · primary-nova')
    const comet = deriveHeadlessTabIdentity(
      'agent:mable:project:hrc-runtime:task:primary-comet',
      fixtureIdentity('agent:mable:project:hrc-runtime:task:primary-comet')
    )
    expect(comet.tabKey).toBe('project:hrc-runtime:primary-comet')
    const primary = deriveHeadlessTabIdentity(
      'agent:mable:project:hrc-runtime:task:primary',
      fixtureIdentity('agent:mable:project:hrc-runtime:task:primary')
    )
    expect(nova.tabKey).not.toBe(comet.tabKey)
    expect(nova.tabKey).not.toBe(primary.tabKey)
  })

  it('qualifies an agent-only ref by agent root when no project is present', () => {
    const id = deriveHeadlessTabIdentity('agent:daedalus', fixtureIdentity('agent:daedalus'))
    expect(id.tabKey).toBe('project:agent-root-daedalus:primary')
    expect(id.agentId).toBe('daedalus')
  })

  it('falls back to an unparsed key for a malformed ref (never throws)', () => {
    const id = deriveHeadlessTabIdentity('::::garbage::::', fixtureIdentity('::::garbage::::'))
    expect(id.tabKey.startsWith('unparsed:')).toBe(true)
    expect(id.agentId).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// T-06321: canonical pane key from normalized (scopeRef, laneRef)
// ---------------------------------------------------------------------------
describe('deriveHeadlessSessionIdentity', () => {
  it('keeps the shared tab but distinguishes the pane key by role', () => {
    const tester = deriveHeadlessSessionIdentity(
      'agent:cody:project:agent-loop:task:T-06319:role:tester',
      undefined,
      fixtureIdentity('agent:cody:project:agent-loop:task:T-06319:role:tester')
    )
    const impl = deriveHeadlessSessionIdentity(
      'agent:cody:project:agent-loop:task:T-06319:role:implementer',
      undefined,
      fixtureIdentity('agent:cody:project:agent-loop:task:T-06319:role:implementer')
    )
    // Same task tab...
    expect(tester.tab.tabKey).toBe('task:T-06319')
    expect(impl.tab.tabKey).toBe('task:T-06319')
    // ...but distinct pane keys and role names.
    expect(tester.paneKey).not.toBe(impl.paneKey)
    expect(tester.roleName).toBe('tester')
    expect(impl.roleName).toBe('implementer')
    expect(tester.laneRef).toBe('main')
  })

  it('distinguishes the pane key by lane for one scope', () => {
    const scope = 'agent:cody:project:agent-loop:task:T-06319'
    const main = deriveHeadlessSessionIdentity(scope, undefined, fixtureIdentity(scope))
    const forked = deriveHeadlessSessionIdentity(scope, 'lane:forked', fixtureIdentity(scope))
    expect(main.tab.tabKey).toBe(forked.tab.tabKey)
    expect(main.paneKey).not.toBe(forked.paneKey)
    expect(main.laneRef).toBe('main')
    expect(forked.laneRef).toBe('lane:forked')
  })

  it('an omitted lane normalizes to main; explicit main is identical', () => {
    const scope = 'agent:clod:project:hrc-runtime:task:T-06321'
    expect(deriveHeadlessSessionIdentity(scope, undefined, fixtureIdentity(scope)).paneKey).toBe(
      deriveHeadlessSessionIdentity(scope, 'main', fixtureIdentity(scope)).paneKey
    )
    expect(
      deriveHeadlessSessionIdentity(scope, undefined, fixtureIdentity(scope)).roleName
    ).toBeUndefined()
  })

  it('keeps the opaque scope in the pane key when identity is absent', () => {
    const id = deriveHeadlessSessionIdentity(
      '::::garbage::::',
      'lane:x',
      fixtureIdentity('::::garbage::::')
    )
    expect(id.paneKey).toBe('::::garbage::::#lane:x')
    expect(id.paneKey.endsWith('#lane:x')).toBe(true)
    expect(id.tab.tabKey.startsWith('unparsed:')).toBe(true)
  })
})

it('groups by the supplied HRC identity and keeps the scope opaque', () => {
  const scopeRef = 'opaque-session-scope'
  const stored = {
    kind: 'project-task' as const,
    agentId: 'cody',
    projectId: 'hrc-runtime',
    taskId: 'T-10148',
  }
  const result = deriveHeadlessSessionIdentity(scopeRef, 'main', stored)
  expect(result.tab.agentId).toBe('cody')
  expect(result.tab.tabKey).toBe('task:T-10148')
  expect(result.paneKey).toBe(`${scopeRef}#main`)
})
