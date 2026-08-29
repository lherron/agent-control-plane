import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openInterfaceStore } from '../open-store.js'
import { DELIVERY_ATTEMPTS_EXHAUSTED } from '../repos/discord-ledger-delivery-repo.js'

const MIRROR = { gatewayId: 'discord', envelopeId: 'EN-01351', sink: 'mirror' }
const TARGET = { ...MIRROR, channelId: 'channel:control-plane' }

function withStoreDirectory(fn: (dbPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'acp-ledger-delivery-'))
  try {
    fn(join(directory, 'interface.sqlite'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Discord ledger delivery store', () => {
  test('claims an attempt, then records the message id Discord returned', () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    const deliveries = store.discordLedgerDeliveries

    expect(deliveries.get(MIRROR)).toBeUndefined()

    const claim = deliveries.beginAttempt({ ...TARGET, maxAttempts: 3 })
    expect(claim.outcome).toBe('attempting')
    expect(claim.delivery).toEqual(
      expect.objectContaining({ state: 'attempting', attempts: 1, channelId: TARGET.channelId })
    )

    const sent = deliveries.markSent(MIRROR, '1543342657894359084')
    expect(sent).toEqual(
      expect.objectContaining({
        state: 'sent',
        attempts: 1,
        discordMessageId: '1543342657894359084',
      })
    )

    // A sent row is terminal: a later pass must not post again.
    const again = deliveries.beginAttempt({ ...TARGET, maxAttempts: 3 })
    expect(again.outcome).toBe('terminal')
    expect(again.delivery.attempts).toBe(1)
    store.close()
  })

  test('T5c: the attempt is spent in the same durable write, so a crash before the send keeps it', () => {
    withStoreDirectory((dbPath) => {
      const first = openInterfaceStore({ dbPath })
      const claim = first.discordLedgerDeliveries.beginAttempt({ ...TARGET, maxAttempts: 3 })
      expect(claim.outcome).toBe('attempting')
      expect(claim.delivery.attempts).toBe(1)
      // Crash: the process dies here, between the durable write and the send.
      // Nothing marks the row `sent`, and nothing rewinds the increment either.
      first.close()

      const restarted = openInterfaceStore({ dbPath })
      const recovered = restarted.discordLedgerDeliveries.get(MIRROR)
      expect(recovered).toEqual(
        expect.objectContaining({ state: 'attempting', attempts: 1, discordMessageId: undefined })
      )

      // The next attempt spends the next unit of budget rather than restarting it.
      const resend = restarted.discordLedgerDeliveries.beginAttempt({ ...TARGET, maxAttempts: 3 })
      expect(resend.outcome).toBe('attempting')
      expect(resend.delivery.attempts).toBe(2)
      restarted.close()
    })
  })

  test('T5b: crash-then-reconcile cycles stop at the ceiling and the row is never resent', () => {
    withStoreDirectory((dbPath) => {
      const maxAttempts = 3
      const outcomes: string[] = []
      // Drive MORE cycles than the ceiling; each restart misses the
      // reconciliation window and would otherwise resend forever.
      for (let cycle = 0; cycle < maxAttempts + 3; cycle += 1) {
        const store = openInterfaceStore({ dbPath })
        outcomes.push(
          store.discordLedgerDeliveries.beginAttempt({ ...TARGET, maxAttempts }).outcome
        )
        store.close()
      }

      expect(outcomes).toEqual([
        'attempting',
        'attempting',
        'attempting',
        'exhausted',
        'terminal',
        'terminal',
      ])

      const store = openInterfaceStore({ dbPath })
      expect(store.discordLedgerDeliveries.get(MIRROR)).toEqual(
        expect.objectContaining({
          state: 'failed',
          attempts: maxAttempts,
          failureReason: DELIVERY_ATTEMPTS_EXHAUSTED,
        })
      )
      store.close()
    })
  })

  test('a failed row stays failed and keeps its reason', () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    const deliveries = store.discordLedgerDeliveries

    expect(deliveries.beginAttempt({ ...TARGET, maxAttempts: 2 }).outcome).toBe('attempting')
    expect(deliveries.markFailed(MIRROR, 'rate_limited').failureReason).toBe('rate_limited')

    const after = deliveries.beginAttempt({ ...TARGET, maxAttempts: 2 })
    expect(after.outcome).toBe('terminal')
    expect(after.delivery).toEqual(
      expect.objectContaining({ state: 'failed', attempts: 1, failureReason: 'rate_limited' })
    )
    store.close()
  })

  test('rejects a non-positive attempt ceiling', () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    expect(() => store.discordLedgerDeliveries.beginAttempt({ ...TARGET, maxAttempts: 0 })).toThrow(
      'maxDeliveryAttempts must be a positive integer'
    )
    store.close()
  })

  test('tracks each sink of an envelope independently for the cursor', () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    const deliveries = store.discordLedgerDeliveries

    deliveries.beginAttempt({ ...TARGET, maxAttempts: 2 })
    deliveries.beginAttempt({
      gatewayId: 'discord',
      envelopeId: 'EN-01351',
      sink: 'human-notice',
      channelId: 'channel:thread',
      bindingId: 'binding-1',
      maxAttempts: 2,
    })

    expect(deliveries.listByEnvelope('discord', 'EN-01351').map((row) => row.sink)).toEqual([
      'human-notice',
      'mirror',
    ])
    expect(deliveries.listAttempting('discord')).toHaveLength(2)

    deliveries.markSent(MIRROR, 'message-1')
    expect(deliveries.listAttempting('discord').map((row) => row.sink)).toEqual(['human-notice'])
    store.close()
  })

  test('prunes route-scoped rows with their binding and leaves the mirror alone', () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    const deliveries = store.discordLedgerDeliveries

    deliveries.beginAttempt({ ...TARGET, maxAttempts: 2 })
    deliveries.beginAttempt({
      gatewayId: 'discord',
      envelopeId: 'EN-01351',
      sink: 'human-notice',
      channelId: 'channel:thread',
      bindingId: 'binding-1',
      maxAttempts: 2,
    })

    expect(deliveries.pruneBindings('discord', ['binding-1'])).toBe(0)
    expect(deliveries.pruneBindings('discord', ['binding-2'])).toBe(1)
    expect(deliveries.listByEnvelope('discord', 'EN-01351').map((row) => row.sink)).toEqual([
      'mirror',
    ])

    expect(deliveries.pruneBindings('discord', [])).toBe(0)
    expect(deliveries.get(MIRROR)).toBeDefined()
    store.close()
  })
})
