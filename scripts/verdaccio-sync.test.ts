import { describe, expect, test } from 'bun:test'
import type { CoherenceGroup } from './lib/verdaccio-sync'

type ResolveLatestWithRetries = (
  groups: readonly CoherenceGroup[],
  options: {
    readLatest: (name: string) => Promise<string>
    sleep?: (ms: number) => Promise<void>
    maxRetries?: number
    retryDelayMs?: number
    warn?: (message: string) => void
  }
) => Promise<Map<string, string>>

async function loadResolver(): Promise<ResolveLatestWithRetries> {
  const mod = await import('./lib/verdaccio-sync')
  const resolver = (mod as { resolveLatestWithRetries?: unknown }).resolveLatestWithRetries
  expect(typeof resolver).toBe('function')
  return resolver as ResolveLatestWithRetries
}

const aspGroup: CoherenceGroup = {
  label: 'ASP',
  packages: ['agent-scope', 'spaces-config'],
}

describe('verdaccio latest coherence retry', () => {
  test('retries a torn read-during-publish sample and resolves when the group becomes coherent', async () => {
    const resolveLatestWithRetries = await loadResolver()
    const calls = new Map<string, number>()
    const sleeps: number[] = []
    const warnings: string[] = []

    // T-05858: the first group sweep sees a mid-wave mix, but the next sweep
    // sees the completed coherent publish and must not fail the install gate.
    const latest = await resolveLatestWithRetries([aspGroup], {
      maxRetries: 3,
      retryDelayMs: 1,
      readLatest: async (name) => {
        const count = calls.get(name) ?? 0
        calls.set(name, count + 1)
        if (name === 'agent-scope' && count === 0) return '0.1.1-dev.20260706131400'
        return '0.1.1-dev.20260706131551'
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      warn: (message) => warnings.push(message),
    })

    expect(latest).toEqual(
      new Map([
        ['agent-scope', '0.1.1-dev.20260706131551'],
        ['spaces-config', '0.1.1-dev.20260706131551'],
      ])
    )
    expect(calls).toEqual(
      new Map([
        ['agent-scope', 2],
        ['spaces-config', 2],
      ])
    )
    expect(sleeps).toEqual([1])
    expect(warnings.join('\n')).toContain('ASP')
    expect(warnings.join('\n')).toContain('agent-scope@0.1.1-dev.20260706131400')
    expect(warnings.join('\n')).toContain('spaces-config@0.1.1-dev.20260706131551')
  })

  test('fails closed after retries exhaust and reports the torn package versions', async () => {
    const resolveLatestWithRetries = await loadResolver()
    const calls = new Map<string, number>()
    const sleeps: number[] = []

    let thrown: unknown
    try {
      await resolveLatestWithRetries([aspGroup], {
        maxRetries: 2,
        retryDelayMs: 1,
        readLatest: async (name) => {
          calls.set(name, (calls.get(name) ?? 0) + 1)
          return name === 'agent-scope' ? '0.1.1-dev.20260706131400' : '0.1.1-dev.20260706131551'
        },
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    expect(message).toContain('ASP Verdaccio latest set is incoherent')
    expect(message).toContain('agent-scope@0.1.1-dev.20260706131400')
    expect(message).toContain('spaces-config@0.1.1-dev.20260706131551')
    expect(calls).toEqual(
      new Map([
        ['agent-scope', 3],
        ['spaces-config', 3],
      ])
    )
    expect(sleeps).toEqual([1, 1])
  })
})
