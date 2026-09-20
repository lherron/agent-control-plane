import { describe, expect, test } from 'bun:test'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
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
  test('reads one target through the exact route, never the fleet target list', async () => {
    let requested: string | undefined
    const client = {
      async getTarget(sessionRef: string) {
        requested = sessionRef
        return { sessionRef, activeHostSessionId: 'hsid-exact' }
      },
      async getSession(hostSessionId: string) {
        return { hostSessionId }
      },
      async listTargets() {
        throw new Error('targetBySessionRef() must not start a fleet-wide list')
      },
    } as unknown as HrcClient

    const port = createSocketInjectionPort(client)
    expect(
      await port.targetBySessionRef('agent:astra:project:agent-control-plane/lane:main')
    ).toEqual({ hostSessionId: 'hsid-exact' })
    expect(requested).toBe('agent:astra:project:agent-control-plane/lane:main')
  })

  test('maps only the authoritative unknown-session response to an absent target', async () => {
    const client = {
      async getTarget() {
        throw new HrcDomainError(HrcErrorCode.UNKNOWN_SESSION, 'unknown session', {})
      },
    } as unknown as HrcClient

    const port = createSocketInjectionPort(client)
    expect(
      await port.targetBySessionRef('agent:astra:project:agent-control-plane/lane:main')
    ).toBeUndefined()
  })

  test('reads one runtime through the exact inspection route, never the paginated fleet list', async () => {
    let inspected: string | undefined
    const client = {
      async inspectRuntime({ runtimeId }: { runtimeId: string }) {
        inspected = runtimeId
        return {
          runtimeId,
          status: 'ready',
          activeInvocationId: 'inv-observed-on-inspect-wire',
        }
      },
      async listRuntimes() {
        throw new Error('runtime() must not start a fleet-wide list')
      },
    } as unknown as HrcClient

    const port = createSocketInjectionPort(client)
    expect(await port.runtime('rt-exact')).toEqual({
      runtimeId: 'rt-exact',
      status: 'ready',
      activeInvocationId: 'inv-observed-on-inspect-wire',
    })
    expect(inspected).toBe('rt-exact')
  })

  test('maps only the authoritative unknown-runtime response to an absent lookup', async () => {
    const client = {
      async inspectRuntime() {
        throw new HrcDomainError(HrcErrorCode.UNKNOWN_RUNTIME, 'unknown runtime', {})
      },
    } as unknown as HrcClient

    const port = createSocketInjectionPort(client)
    expect(await port.runtime('rt-missing')).toBeUndefined()
  })

  test('advances past an accepted newer-or-equal broker boundary', async () => {
    const requested: number[] = []
    const observed: number[] = []
    const client = {
      async declareSubscriber() {
        return { subscriberId: 'subscriber-mail' }
      },
      async followBrokerEvents(request: { afterCommit: number }) {
        requested.push(request.afterCommit)
        return request.afterCommit === 40
          ? {
              events: [{ commitOrdinal: 41, invocationId: 'inv-1', seq: 1 }],
              nextCommit: 41,
            }
          : { events: [], nextCommit: request.afterCommit }
      },
    } as unknown as HrcClient

    const port = createSocketInjectionPort(client)
    const unsubscribe = await port.subscribeBroker({
      afterCommit: 40,
      onEvent: (event) => observed.push(event.commitOrdinal),
    })
    await eventually(() => expect(requested.slice(0, 2)).toEqual([40, 42]))
    expect(observed).toEqual([41])
    await unsubscribe()
  })

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
