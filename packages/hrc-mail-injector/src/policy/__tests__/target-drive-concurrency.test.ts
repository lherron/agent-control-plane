import { describe, expect, it } from 'bun:test'

import type { MailKickerDependencies } from '../contracts.js'
import { createMailKicker } from '../controller.js'
import { MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES } from '../internal.js'

describe('mail target drive concurrency', () => {
  it('does not admit a fifth HRC lookup until one of four target drives releases', async () => {
    let releaseLookups: (() => void) | undefined
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookups = resolve
    })
    let activeLookups = 0
    let maximumActiveLookups = 0
    let enteredLookups = 0
    const dependencies = {
      store: {
        mailDelivery: {
          resolveBirthRefusal: () => false,
        },
      },
      port: {
        resolveForeignHome: async () => {
          enteredLookups += 1
          activeLookups += 1
          maximumActiveLookups = Math.max(maximumActiveLookups, activeLookups)
          await lookupGate
          activeLookups -= 1
          return { homeNodeId: 'svc', source: 'registry' as const }
        },
      },
      ledger: {},
      nodeId: 'max3',
      foreignHomeMemo: new Map(),
      log: () => undefined,
    } as unknown as MailKickerDependencies
    const kicker = createMailKicker(dependencies, { enabled: true, sweepIntervalMs: 60_000 })

    const operations = Array.from({ length: 12 }, (_, index) => {
      const target = `agent:cody:project:agent-control-plane:task:T-9${String(index).padStart(4, '0')}/lane:main`
      kicker.mailKickerPendingTargets.set(target, 'periodic')
      return kicker.drainTarget(target)
    })

    await Bun.sleep(10)
    expect(enteredLookups).toBe(MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES)
    expect(maximumActiveLookups).toBe(MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES)

    releaseLookups?.()
    await Promise.all(operations)
    expect(enteredLookups).toBe(12)
    expect(maximumActiveLookups).toBe(MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES)
  })

  it('admits newly inserted mail ahead of queued periodic maintenance', async () => {
    let unblockFuture = false
    const blockedLookupReleases: Array<() => void> = []
    const entered: string[] = []
    const dependencies = {
      store: { mailDelivery: { resolveBirthRefusal: () => false } },
      port: {
        resolveForeignHome: async (scopeRef: string) => {
          entered.push(scopeRef)
          if (!unblockFuture) {
            await new Promise<void>((resolve) => blockedLookupReleases.push(resolve))
          }
          return { homeNodeId: 'svc', source: 'registry' as const }
        },
      },
      ledger: {},
      nodeId: 'max3',
      foreignHomeMemo: new Map(),
      log: () => undefined,
    } as unknown as MailKickerDependencies
    const kicker = createMailKicker(dependencies, { enabled: true, sweepIntervalMs: 60_000 })
    const target = (name: string) => `agent:cody:project:agent-control-plane:task:${name}/lane:main`
    const operations: Promise<void>[] = []

    for (let index = 0; index < MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES + 1; index += 1) {
      const ref = target(`T-periodic-${index}`)
      kicker.mailKickerPendingTargets.set(ref, 'periodic')
      operations.push(kicker.drainTarget(ref))
    }
    await Bun.sleep(10)
    const inserted = target('T-insert')
    kicker.mailKickerPendingTargets.set(inserted, 'insert')
    operations.push(kicker.drainTarget(inserted))

    unblockFuture = true
    blockedLookupReleases.shift()?.()
    await Bun.sleep(10)
    expect(entered.at(MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES)).toContain('T-insert')

    for (const release of blockedLookupReleases.splice(0)) release()
    await Promise.all(operations)
  })
})
