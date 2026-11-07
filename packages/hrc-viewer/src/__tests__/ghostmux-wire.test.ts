import { expect, it } from 'bun:test'
import {
  parseGhostmuxSurfaceState,
  parseGhostmuxWindowList,
  parseGhostmuxWindowState,
} from '../ghostmux-client'

it('keeps surface aliases and rejects missing identity', () => {
  for (const wrapper of ['terminal', 'surface', 'pane']) {
    expect(
      parseGhostmuxSurfaceState(JSON.stringify({ [wrapper]: { uuid: 's', windowId: 'w' } }))
    ).toMatchObject({ surfaceId: 's', windowId: 'w', createdBy: 'ghostmux' })
  }
  expect(() => parseGhostmuxSurfaceState('{}')).toThrow('did not return a surface id')
})

it('keeps window identity separate from terminals and preserves server list order', () => {
  expect(parseGhostmuxWindowState('{"id":"w","created":true,"terminal_ids":["s",1]}')).toEqual({
    windowId: 'w',
    created: true,
    terminalIds: ['s'],
  })
  expect(
    parseGhostmuxWindowList(
      JSON.stringify({
        windows: [
          { id: 'older', metadata: { hrc_window_key: 'console' } },
          null,
          { title: 'no id' },
          { window_id: 'newer', metadata: [] },
        ],
      })
    )
  ).toEqual([
    { windowId: 'older', metadata: { hrc_window_key: 'console' } },
    { windowId: 'newer', metadata: {} },
  ])
  expect(() => parseGhostmuxWindowState('')).toThrow('did not return a window id')
})
