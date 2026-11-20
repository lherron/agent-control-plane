import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { closeMobileWebSocket, handleMobileWebSocketMessage } from '../../src/handlers/mobile.js'
import { resolvePluginPagesOptions } from '../../src/plugin-pages/options.js'
import { type PluginFixture, createPluginFixture } from './fixtures.js'

type Frame = Record<string, any>

function fakeSocket(fx: PluginFixture, kind = 'dashboard') {
  const frames: Frame[] = []
  const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = []
  const ws = {
    data: {
      deps: { pluginPages: resolvePluginPagesOptions(fx.options) },
      url: 'ws://acp.test/v1/mobile/dashboard',
      kind,
      version: 1,
      abortController: new AbortController(),
    },
    send(message: string) {
      const frame = JSON.parse(message) as Frame
      frames.push(frame)
      for (const waiter of [...waiters]) {
        if (waiter.match(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(frame)
        }
      }
      return message.length
    },
    close() {},
  }
  const next = (match: (f: Frame) => boolean) =>
    new Promise<Frame>((resolve) => {
      const found = frames.find(match)
      if (found !== undefined) resolve(found)
      else waiters.push({ match, resolve })
    })
  const send = (frame: unknown) => handleMobileWebSocketMessage(ws as never, JSON.stringify(frame))
  return { ws, frames, next, send }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let fx: PluginFixture
beforeEach(() => {
  fx = createPluginFixture()
  fx.writePlugin(
    'jobhunt',
    {
      pages: {
        pipeline: { title: 'P', icon: 'p', mounts: { jobhunt: { ops: ['hunt.pipeline'] } } },
      },
    },
    { pipeline: { 'index.html': 'x' } }
  )
})
afterEach(() => fx.cleanup())

const subscribe = (id: string, mount = 'jobhunt:hunt') => ({
  type: 'plugin.subscribe',
  id,
  page: 'jobhunt:pipeline',
  mount,
  args: { type: 'hunt.lead' },
})

describe('plugin.subscribe on the mobile socket', () => {
  test('relays the subscribe reply and a diff verbatim; unsubscribe kills the watch child', async () => {
    const socket = fakeSocket(fx)
    socket.send(subscribe('s1'))
    const reply = await socket.next((f) => f.type === 'plugin.line' && f.line.includes('"rows"'))
    expect(reply).toEqual({
      type: 'plugin.line',
      id: 's1',
      line: '{"generation":1,"id":1,"ok":true,"result":{"cursor":7,"rows":[]}}',
    })
    const diff = await socket.next((f) => f.type === 'plugin.line' && f.line.includes('"diff"'))
    expect(diff.line).toBe('{"event":{"cursor":8,"diff":[{"id":"n1"}]}}')
    const call = fx.calls().at(-1)!
    expect(call.argv.slice(0, 5)).toEqual(['jobhunt/hunt', 'watch', '--args', '-', '--raw'])
    expect(JSON.parse(call.stdin)).toEqual({ type: 'hunt.lead' })
    const pid = fx.watchPid()
    expect(alive(pid)).toBe(true)
    socket.send({ type: 'plugin.unsubscribe', id: 's1' })
    const closed = await socket.next((f) => f.type === 'plugin.closed' && f.id === 's1')
    expect(closed.reason).toBe('unsubscribed')
    expect(alive(pid)).toBe(false)
  })

  test('socket close kills every watch child', async () => {
    const socket = fakeSocket(fx)
    socket.send(subscribe('s1'))
    await socket.next((f) => f.type === 'plugin.line' && f.line.includes('"diff"'))
    const pid = fx.watchPid()
    closeMobileWebSocket(socket.ws as never)
    await socket.next((f) => f.type === 'plugin.closed' && f.id === 's1')
    expect(alive(pid)).toBe(false)
  })

  test('allowlist refusals and protocol errors never start a child', async () => {
    const socket = fakeSocket(fx)
    socket.send(subscribe('a', 'signal-pipeline:signal'))
    socket.send(subscribe('b', 'ui:ui'))
    socket.send({ ...subscribe('c'), page: 'jobhunt:nope' })
    socket.send({ ...subscribe('d'), args: 'not-an-object' })
    socket.send({ type: 'plugin.unsubscribe', id: 'never' })
    const codes = await Promise.all(
      ['a', 'b', 'c', 'd', 'never'].map((id) =>
        socket.next((f) => f.type === 'plugin.error' && f.id === id)
      )
    )
    expect(codes.map((f) => f.error.code)).toEqual([
      'mount_not_allowed',
      'mount_not_allowed',
      'page_not_found',
      'invalid_request',
      'unknown_subscription',
    ])
    expect(fx.calls()).toHaveLength(0)
  })

  test('a mount with no live kernel closes the subscription as mount_unavailable', async () => {
    fx.writePlugin(
      'jobhunt',
      { pages: { pipeline: { title: 'P', icon: 'p', mounts: { gone: { ops: ['x'] } } } } },
      { pipeline: { 'index.html': 'x' } }
    )
    const socket = fakeSocket(fx)
    socket.send(subscribe('g', 'gone'))
    const closed = await socket.next((f) => f.type === 'plugin.closed' && f.id === 'g')
    expect(closed).toMatchObject({
      reason: 'exited',
      exitCode: 75,
      error: { code: 'mount_unavailable' },
    })
  })

  test('plugin frames are accepted on the dashboard socket only', async () => {
    const socket = fakeSocket(fx, 'timeline')
    socket.send(subscribe('s1'))
    socket.send({ type: 'ping', id: 'p' })
    expect(socket.frames).toEqual([])
    expect(fx.calls()).toHaveLength(0)
  })
})
