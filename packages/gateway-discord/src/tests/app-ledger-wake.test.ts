import { expect, test } from 'bun:test'
import type { WorkClient } from '@wrkq/client'
import { openInterfaceStore } from 'acp-interface-store'
import { GatewayDiscordApp } from '../app.js'
import { createAcpFetch } from './app-acp-fixture.test.js'
import { createClient } from './app-discord-fixture.test.js'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('ledger egress parks between coarse wakes, reads one bounded page, and aborts on stop', async () => {
  const store = openInterfaceStore({ dbPath: ':memory:' })
  store.discordLedgerProjection.advanceCursor('discord_prod', 40)
  let revision = 0
  let wake: (() => void) | undefined
  const order: string[] = []
  const calls: unknown[] = []
  const waits: number[] = []
  const waker = {
    async token() {
      order.push('token')
      return revision
    },
    async wait(since: number, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
      waits.push(options.timeoutMs ?? 0)
      if (since !== revision || options.signal?.aborted) return
      await new Promise<void>((resolve) => {
        const finish = () => {
          options.signal?.removeEventListener('abort', finish)
          wake = undefined
          resolve()
        }
        wake = finish
        options.signal?.addEventListener('abort', finish, { once: true })
      })
    },
  }
  const app = new GatewayDiscordApp({
    acpBaseUrl: 'http://acp.test',
    gatewayId: 'discord_prod',
    client: createClient() as never,
    fetchImpl: createAcpFetch({}).fetchImpl,
    deliveryPollMs: 5,
    deliveryIdleMs: 5,
    ledgerHumanEgress: {
      store,
      commitWaker: waker,
      client: {
        async call(method: string, params: unknown) {
          order.push('view')
          calls.push({ method, params })
          // Simulate a commit between token capture and completion of the read.
          if (calls.length === 1) revision++
          return { items: [], high_water: 40 }
        },
      } as unknown as WorkClient,
    },
  })
  try {
    await app.start()
    await pause(35)
    expect(order).toEqual(['token', 'view', 'token', 'view'])
    expect(calls).toHaveLength(2)
    revision++
    wake?.()
    await pause(15)
    expect(calls).toHaveLength(3)
    expect(calls[2]).toEqual({
      method: 'wrkq.monitor.eventsView',
      params: { cursor: 40, eventTypes: ['envelope.created', 'envelope.failed'], limit: 200 },
    })
    expect(waits).toEqual([25_000, 25_000, 25_000])
  } finally {
    await app.stop()
    store.close()
  }
  expect(wake).toBeUndefined()
})
