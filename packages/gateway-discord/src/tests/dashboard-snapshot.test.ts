import { afterEach, describe, expect, test } from 'bun:test'

import { fetchDashboardSnapshotViaWebSocket } from '../app.js'

describe('dashboard snapshot websocket', () => {
  let server: ReturnType<typeof Bun.serve> | undefined

  afterEach(() => {
    server?.stop(true)
    server = undefined
  })

  test('resolves the snapshot before clean client teardown dispatches close', async () => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return
        return new Response('WebSocket upgrade failed', { status: 400 })
      },
      websocket: {
        open(ws) {
          ws.send(
            JSON.stringify({
              type: 'dashboard_snapshot',
              sessions: [],
              cursors: { lastHrcSeq: 42 },
            })
          )
        },
        message() {},
      },
    })

    const snapshot = await fetchDashboardSnapshotViaWebSocket(`http://127.0.0.1:${server.port}`)

    expect(snapshot).toMatchObject({
      type: 'dashboard_snapshot',
      cursors: { lastHrcSeq: 42 },
    })
  })
})
