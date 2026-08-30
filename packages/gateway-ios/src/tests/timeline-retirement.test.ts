import { describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import type { HrcClient } from 'hrc-sdk'

import { type WsData, createGatewayIosRoutes, createGatewayIosWsHandlers } from '../routes.js'

const deps = {
  hrcClient: {} as HrcClient,
  gatewayId: 'gateway-ios-test',
}

describe('retired gateway-ios timeline authority', () => {
  test('GET /v1/history directs callers to ACP', async () => {
    const response = await createGatewayIosRoutes(deps).fetch(
      new Request('http://ios.test/v1/history')
    )

    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'timeline_moved',
      message: 'Use the ACP /v1/mobile/history route.',
    })
  })

  test('WS /v1/timeline is not upgraded and directs callers to ACP', async () => {
    const server = { upgrade: () => true } as unknown as Server<WsData>
    const response = createGatewayIosWsHandlers(deps).tryUpgrade(
      new Request('http://ios.test/v1/timeline?sessionRef=agent:cody'),
      server
    )

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(410)
    expect(await (response as Response).json()).toEqual({
      ok: false,
      code: 'timeline_moved',
      message: 'Use the ACP /v1/mobile/sessions/:hostSessionId/timeline route.',
    })
  })
})
