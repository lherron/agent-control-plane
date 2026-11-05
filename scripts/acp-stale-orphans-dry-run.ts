/** Read-only production inventory. This command deliberately has no apply mode. */
import { Database } from 'bun:sqlite'
import { parseArgs } from 'node:util'
import { InputAdmissionRepo, InputApplicationRepo, InputQueueRepo, RunRepo } from 'acp-state-store'
import { resolveControlSocketPath, resolveDatabasePath } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import {
  STALE_NEVER_DISPATCHED_MS,
  STALE_UNROUTABLE_MS,
  createStaleOrphanReaper,
} from '../packages/acp-server/src/integration/stale-orphan-reaper.js'

const { values } = parseArgs({
  options: {
    'state-db': { type: 'string', default: '/Users/lherron/praesidium/var/db/acp-state.db' },
    'jobs-db': { type: 'string', default: '/Users/lherron/praesidium/var/db/acp-jobs.db' },
    'hrc-db': { type: 'string', default: resolveDatabasePath() },
    'hrc-socket': { type: 'string', default: resolveControlSocketPath() },
  },
})
function openReadOnly(path: string) {
  const db = new Database(path, { readonly: true })
  // Reuse production codecs without opening/migrating the production store.
  const sqlite: ConstructorParameters<typeof RunRepo>[0]['sqlite'] = {
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        all: (...params) => statement.all(...(params as never[])),
        get: (...params) => statement.get(...(params as never[])) ?? undefined,
        run: () => {
          throw new Error('dry-run database is read-only')
        },
      }
    },
    transaction: (fn) => db.transaction(fn),
    exec: () => {
      throw new Error('dry-run database is read-only')
    },
    pragma: () => {
      throw new Error('dry-run database is read-only')
    },
    close: () => db.close(),
  }
  return { db, sqlite }
}
const { db, sqlite } = openReadOnly(values['state-db'])
const jobs = openReadOnly(values['jobs-db'])
const client = new HrcClient({ socketPath: values['hrc-socket'], caller: 'acp-server' })
try {
  const context = { sqlite }
  const report = await createStaleOrphanReaper({
    sqlite,
    runStore: new RunRepo(context),
    inputQueueStore: new InputQueueRepo(context),
    inputAdmissionStore: new InputAdmissionRepo(context),
    inputApplicationStore: new InputApplicationRepo(context),
    hrcDbPath: values['hrc-db'],
    hrcClient: client,
    jobsStore: {
      sqlite: jobs.sqlite,
      updateJobRun: () => {
        throw new Error('dry-run database is read-only')
      },
    },
    verifyJobNode: async () => (await client.getStatus({ includeSessions: false })).node.nodeId,
  }).dryRun()
  const counts: Record<string, number> = {}
  for (const a of report.actions) {
    const key = `${a.table}:${a.from}->${a.to}:${a.reason}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        bounds: { neverDispatchedMs: STALE_NEVER_DISPATCHED_MS, unroutableMs: STALE_UNROUTABLE_MS },
        counts,
        ...report,
      },
      null,
      2
    )
  )
} finally {
  db.close()
  jobs.db.close()
}
