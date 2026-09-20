import { describe, expect, test } from 'bun:test'

import { createSocketInjectionPort } from '../src/policy/socket-injection-port.js'

describe('socket injector broker observer', () => {
  test('reconnects after one failed broker follow and delivers the next committed record', async () => {
    let follows = 0
    const client = {
      declareSubscriber: async () => ({}) as never,
      followBrokerEvents: async () => {
        follows += 1
        if (follows === 1) throw new Error('socket dropped')
        if (follows === 2) {
          return {
            events: [
              {
                commitOrdinal: 41,
                invocationId: 'inv-reconnect',
                runtimeId: 'rt-reconnect',
                seq: 7,
                time: new Date().toISOString(),
                type: 'submission.executed',
                brokerEventJson: JSON.stringify({ submissionId: 'sub-reconnect' }),
                projectionStatus: 'projected',
                createdAt: new Date().toISOString(),
                evidenceOrigin: 'live',
              },
            ],
            nextCommit: 41,
          }
        }
        return { events: [], nextCommit: 41 }
      },
    }
    const port = createSocketInjectionPort(client as never)
    const observed: string[] = []
    const unsubscribe = await port.subscribeBroker({
      afterCommit: 0,
      onEvent: (event) => observed.push(event.type),
    })
    try {
      for (let attempts = 0; observed.length === 0 && attempts < 20; attempts += 1) {
        await Bun.sleep(25)
      }
      expect(observed).toEqual(['submission.executed'])
      expect(follows).toBeGreaterThanOrEqual(2)
    } finally {
      await unsubscribe()
    }
  })
})
