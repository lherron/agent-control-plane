import { describe, expect, test } from 'bun:test'

import type { HrcClient } from 'hrc-sdk'

import { createSocketInjectionPort } from '../src/index.js'

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(10)
    }
  }
  throw lastError
}

describe('socket injection subscriptions', () => {
  test('re-declares mail and resumes broker evidence after HRC restarts', async () => {
    let declarations = 0
    let follows = 0
    let releaseFirstFollow!: () => void
    let releaseRecoveredFollow!: () => void
    const firstFollow = new Promise<void>((resolve) => {
      releaseFirstFollow = resolve
    })
    const recoveredFollow = new Promise<void>((resolve) => {
      releaseRecoveredFollow = resolve
    })
    const client = {
      async declareSubscriber() {
        declarations += 1
        return { subscriberId: `subscriber-${declarations}` }
      },
      async followBrokerEvents() {
        follows += 1
        if (follows === 1) {
          await firstFollow
          throw new Error('HRC socket closed during restart')
        }
        await recoveredFollow
        return { events: [], nextCommit: 41 }
      },
    } as unknown as HrcClient

    const port = createSocketInjectionPort(client)
    const unsubscribe = await port.subscribeBroker({
      afterCommit: 41,
      onEvent: () => {},
    })
    expect(declarations).toBe(1)
    await eventually(() => expect(follows).toBe(1))

    releaseFirstFollow()
    await eventually(() => {
      expect(declarations).toBeGreaterThanOrEqual(2)
      expect(follows).toBeGreaterThanOrEqual(2)
    })

    releaseRecoveredFollow()
    await unsubscribe()
  })

  test('re-declares mail when a lifecycle stream ends with the old daemon', async () => {
    let declarations = 0
    let watches = 0
    let holdRecoveredWatch!: () => void
    const recoveredWatch = new Promise<void>((resolve) => {
      holdRecoveredWatch = resolve
    })
    const client = {
      async declareSubscriber() {
        declarations += 1
        return { subscriberId: `subscriber-${declarations}` }
      },
      watch() {
        watches += 1
        const attempt = watches
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (attempt > 1) await recoveredWatch
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    } as unknown as HrcClient

    const port = createSocketInjectionPort(client)
    const unsubscribe = await port.subscribeLifecycle({
      afterSeq: 10,
      onEvent: () => {},
    })
    await eventually(() => {
      expect(declarations).toBeGreaterThanOrEqual(2)
      expect(watches).toBeGreaterThanOrEqual(2)
    })

    holdRecoveredWatch()
    await unsubscribe()
  })
})
