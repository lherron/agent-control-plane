import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
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

afterEach(() => setSystemTime())

describe('injector commit wake scheduler', () => {
  it('takes token before read, tails only on coarse changes, and stops while parked', async () => {
    const { kicker, calls, waits } = fixture()
    await kicker.start()
    await Bun.sleep(20)
    expect(calls.slice(0, 3)).toEqual(['wait', 'tail', 'wait'])
    expect(waits[0]?.params).toEqual({ since: 'boot', timeoutMs: 25000 })
    waits.shift()?.resolve({ token: 'next', changed: true })
    await Bun.sleep(20)
    expect(calls.filter((call) => call === 'sweep')).toHaveLength(0)
    await kicker.stop()
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
    expect(calls.filter((call) => call === 'sweep')).toHaveLength(0)
    await kicker.stop()
  })

  it('runs recovery at 300 seconds even when unrelated commits keep waking the tail', async () => {
    const { kicker, calls, waits } = fixture()
    const started = Date.now()
    setSystemTime(new Date(started))
    try {
      await kicker.start()
      await Bun.sleep(10)
      setSystemTime(new Date(started + 299000))
      waits.shift()?.resolve({ token: 'unrelated', changed: true })
      await Bun.sleep(20)
      expect(calls.filter((call) => call === 'sweep')).toHaveLength(0)
      expect(waits[0]?.params.timeoutMs).toBe(1000)
      setSystemTime(new Date(started + 300001))
      waits.shift()?.resolve({ token: 'another-unrelated', changed: true })
      await Bun.sleep(20)
      expect(calls.filter((call) => call === 'sweep')).toHaveLength(1)
      expect(calls.filter((call) => call === 'tail')).toHaveLength(3)
    } finally {
      await kicker.stop()
      setSystemTime()
    }
  })
})
