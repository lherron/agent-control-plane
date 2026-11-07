import { expect, it } from 'bun:test'
import { GhostmuxManager } from '../ghostmux'

it('projects only owned panes and tolerates failed metadata probes', async () => {
  const metadata: Record<string, unknown> = {
    owned: { hrc_role: 'headless-agent-pane', hrc_runtime_id: 'rt-old', hrc_generation: 0 },
    shell: {},
  }
  const manager = new GhostmuxManager('ghostmux', async (args) => {
    if (args[0] === 'list-surfaces') {
      return {
        stdout: JSON.stringify({
          terminals: ['owned', 'shell', 'gone'].map((id) => ({ id, window_id: 'w' })),
        }),
        stderr: '',
      }
    }
    const data = metadata[args[3] ?? '']
    if (data === undefined) throw new Error('probe failed')
    return { stdout: JSON.stringify({ data }), stderr: '' }
  })
  expect(await manager.listHeadlessViewerPanes()).toEqual([
    { surfaceId: 'owned', windowId: 'w', windowKey: 'default', runtimeId: 'rt-old', generation: 0 },
  ])
  expect(await manager.findHeadlessViewerSurfaceByRuntimeId('rt-old')).toBe('owned')
  expect(await manager.findHeadlessViewerSurfaceByRuntimeId('absent')).toBeNull()
})

it('rebinds identity metadata without creating, repainting, or attaching', async () => {
  const calls: string[][] = []
  const manager = new GhostmuxManager('ghostmux', async (args) => {
    calls.push(args)
    return { stdout: '{}', stderr: '' }
  })
  await manager.rebindHeadlessViewerPane('pane', {
    scopeRef: 'opaque',
    identity: { kind: 'project-task', agentId: 'cody', projectId: 'acp', taskId: 'T-12709' },
    laneRef: 'lane:review',
    runtimeId: 'rt-new',
    hostSessionId: 'host',
    generation: 0,
    windowKey: ' review room ',
  })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.slice(0, 4)).toEqual(['metadata', 'set', '-t', 'pane'])
  expect(JSON.parse(calls[0]?.[4] ?? '')).toEqual({
    hrc_role: 'headless-agent-pane',
    hrc_window_key: 'review-room',
    hrc_tab_key: 'task:T-12709',
    hrc_pane_key: 'opaque#lane:review',
    hrc_agent_id: 'cody',
    hrc_lane_ref: 'lane:review',
    hrc_project: 'acp',
    hrc_task_id: 'T-12709',
    hrc_scope_ref: 'opaque',
    hrc_runtime_id: 'rt-new',
    hrc_host_session_id: 'host',
    hrc_generation: 0,
  })
})
