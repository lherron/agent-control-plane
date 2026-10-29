import type { SqliteDatabase } from './sqlite.js'

/**
 * Shared optimistic claim-and-lease loop used by `claimDueJobRuns` and
 * `claimPendingInboxEvents`. It runs inside a single transaction: select
 * candidate ids, then per-candidate run a conditional `UPDATE ... WHERE
 * <still-claimable>`, skip rows another worker already took (`changes === 0`),
 * re-read each winning row, and collect the materialized records.
 *
 * It ONLY factors the control flow — every call site supplies its own exact
 * SQL strings, parameter vectors, and re-read closure, so the distinct WHERE
 * predicates (job_runs adds `triggered_at <= ?`; event_inbox does
 * `attempts + 1`), ordering, and projections are preserved verbatim per
 * caller. See the characterization tests in
 * `__tests__/claim-lease.characterization.test.ts`.
 */
export function claimWithLease<Candidate, Result>(
  sqlite: SqliteDatabase,
  spec: {
    selectSql: string
    selectParams: readonly unknown[]
    claimSql: string
    claimParams: (candidate: Candidate) => readonly unknown[]
    reread: (candidate: Candidate) => Result | undefined
  }
): Result[] {
  return sqlite.transaction(() => {
    const candidates = sqlite.prepare(spec.selectSql).all(...spec.selectParams) as Candidate[]

    const results: Result[] = []
    for (const candidate of candidates) {
      const changed = sqlite.prepare(spec.claimSql).run(...spec.claimParams(candidate))
      if (changed.changes === 0) {
        continue
      }
      const record = spec.reread(candidate)
      if (record !== undefined) {
        results.push(record)
      }
    }
    return results
  })()
}
