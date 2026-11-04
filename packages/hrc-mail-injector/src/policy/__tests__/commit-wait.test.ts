import { describe, expect, it } from 'bun:test'
import type { MailKickerDependencies } from '../contracts.js'
import { createMailKicker } from '../controller.js'

function fixture() {
  const calls: string[] = []
  const waits: Array<{
    params: { since?: string; timeoutMs?: number }
    resolve: (value: { token: string; changed: boolean }) => void
  }> = []
  const dependencies = {
    store: {
      mailDelivery: {
        listOpenIntents: () => [],
        listDueReminderTargets: () => [],
        listDueReminders: () => [],
      },
    },
    port: {
      eventsHead: async () => ({ hrcSeq: 0, brokerCommit: 0 }),
      subscribeLifecycle: async () => () => {},
      subscribeBroker: async () => () => {},
    },
    ledger: {
      commitWait: (params: { since?: string; timeoutMs?: number }) => {
        calls.push('wait')
        if (params.since === undefined) return Promise.resolve({ token: 'boot', changed: true })
        return new Promise<{ token: string; changed: boolean }>((resolve) =>
          waits.push({ params, resolve })
        )
      },
    },
    nodeId: 'max3',
    foreignHomeMemo: new Map(),
    log: () => {},
  } as unknown as MailKickerDependencies
  const kicker = createMailKicker(dependencies, { enabled: true, sweepIntervalMs: 10 })
  kicker.runTailOnce = async () => {
    calls.push('tail')
  }
  kicker.runSweepOnce = async () => {
    calls.push('sweep')
  }
  return { kicker, calls, waits }
}

describe('injector commit wake scheduler', () => {
  it('takes token before read, sweeps on changes, and stops while parked', async () => {
    const { kicker, calls, waits } = fixture()
    await kicker.start()
    await Bun.sleep(20)
    expect(calls.slice(0, 4)).toEqual(['wait', 'tail', 'sweep', 'wait'])
    expect(waits[0]?.params).toEqual({ since: 'boot', timeoutMs: 25000 })
    waits.shift()?.resolve({ token: 'next', changed: true })
    await Bun.sleep(20)
    expect(calls.filter((call) => call === 'sweep')).toHaveLength(2)
    const started = Date.now()
    await kicker.stop()
    expect(Date.now() - started).toBeLessThan(200)
    waits.shift()?.resolve({ token: 'late', changed: true })
    await Bun.sleep(10)
    expect(calls.filter((call) => call === 'tail')).toHaveLength(2)
  })

  it('paces immediate unchanged capacity replies without sweeping', async () => {
    const { kicker, calls, waits } = fixture()
    await kicker.start()
    await Bun.sleep(5)
    waits.shift()?.resolve({ token: 'boot', changed: false })
    await Bun.sleep(2)
    expect(calls.filter((call) => call === 'tail')).toHaveLength(1)
    await Bun.sleep(20)
    expect(calls.filter((call) => call === 'tail')).toHaveLength(2)
    expect(calls.filter((call) => call === 'sweep')).toHaveLength(1)
    await kicker.stop()
  })
})
