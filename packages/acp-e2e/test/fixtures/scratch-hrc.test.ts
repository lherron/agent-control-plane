import { existsSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  assertScratchHrcPaths,
  createScratchHrcDaemon,
  runAllTeardownSteps,
} from './scratch-hrc.js'

const PRODUCTION_PATHS = {
  runtimeRoot: '/srv/praesidium/var/run/hrc',
  stateRoot: '/srv/praesidium/var/state/hrc',
  socketPath: '/srv/praesidium/var/run/hrc/hrc.sock',
}

describe('scratch HRC isolation guard', () => {
  test.each([
    ['production runtime root', { ...PRODUCTION_PATHS, stateRoot: '/tmp/scratch-state' }],
    [
      'production state root',
      {
        ...PRODUCTION_PATHS,
        runtimeRoot: '/tmp/scratch-runtime',
        socketPath: '/tmp/scratch-runtime/hrc.sock',
      },
    ],
    [
      'production socket',
      { ...PRODUCTION_PATHS, runtimeRoot: '/tmp/scratch-runtime', stateRoot: '/tmp/scratch-state' },
    ],
  ])('refuses the %s', (_label, paths) => {
    expect(() => assertScratchHrcPaths(paths, PRODUCTION_PATHS)).toThrow(
      'refusing to use production HRC support paths'
    )
  })

  test('accepts an explicitly isolated support root', () => {
    expect(() =>
      assertScratchHrcPaths(
        {
          runtimeRoot: '/tmp/acp-e2e/run',
          stateRoot: '/tmp/acp-e2e/state',
          socketPath: '/tmp/acp-e2e/run/hrc.sock',
        },
        PRODUCTION_PATHS
      )
    ).not.toThrow()
  })

  test('boots a real daemon under scratch paths and removes its whole support root', async () => {
    const daemon = await createScratchHrcDaemon()
    const scratchRoot = daemon.scratchRoot
    try {
      expect(daemon.runtimeRoot.startsWith(scratchRoot)).toBe(true)
      expect(daemon.stateRoot.startsWith(scratchRoot)).toBe(true)
      expect((await daemon.client.getHealth()).ok).toBe(true)
      expect(existsSync(daemon.databasePath)).toBe(true)
    } finally {
      await daemon.close()
    }
    expect(existsSync(scratchRoot)).toBe(false)
  })

  test('runs every teardown step after an earlier scenario cleanup fails', async () => {
    const completed: string[] = []

    await expect(
      runAllTeardownSteps([
        () => {
          completed.push('first')
          throw new Error('scenario cleanup failed')
        },
        () => {
          completed.push('scratch daemon stopped')
        },
        () => {
          completed.push('scratch root removed')
        },
      ])
    ).rejects.toThrow('real-HRC E2E teardown failed')
    expect(completed).toEqual(['first', 'scratch daemon stopped', 'scratch root removed'])
  })
})
