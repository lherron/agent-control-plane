import type { HrcRuntimeSnapshot } from 'hrc-core'

import type { AcpHrcClient } from '../../src/deps.js'
import type { HrcHostSessionReadItem } from '../../src/hrc-client.js'

/**
 * Adds the mobile session page's batch reads to a fake that answers the
 * per-session `getSession` and `listRuntimes`, the way HRC's batch routes
 * answer: one by-host record (or a `not_found` slot) per id, and every runtime
 * row of each id.
 */
export function withBatchSessionReads<T extends object>(client: T): T {
  const fake = client as unknown as Pick<AcpHrcClient, 'getSession' | 'listRuntimes'>
  return Object.assign(client, {
    readSessionsByHostSessionIds: async (ids: string[]): Promise<HrcHostSessionReadItem[]> =>
      Promise.all(
        ids.map(async (hostSessionId) => {
          try {
            return await fake.getSession(hostSessionId)
          } catch {
            return { hostSessionId, error: { code: 'not_found' } }
          }
        })
      ),
    readRuntimesByHostSessionIds: async (ids: string[]): Promise<HrcRuntimeSnapshot[]> =>
      (
        await Promise.all(
          ids.map((hostSessionId) => fake.listRuntimes({ hostSessionId, all: true }))
        )
      ).flat(),
  })
}
