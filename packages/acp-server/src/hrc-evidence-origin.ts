import type { Database } from 'bun:sqlite'

/**
 * SQL conjunct that keeps only HRC evidence allowed to act on current work.
 *
 * HRC marks late-projected historical rows with a non-NULL
 * `hrc_events.evidence_origin` (today only `'retained'`). They keep their
 * original `ts` but get a fresh `hrc_seq`, so sequence-bounded readers would
 * otherwise treat history as current output or activity. The column is additive:
 * on a store that positively predates it, no such rows can exist and today's
 * query is correct.
 *
 * Detection runs on the caller's connection every time (no cache) so an HRC
 * schema upgrade between reads is observed. Callers must evaluate this and the
 * guarded SELECT inside one read transaction ({@link readHrcEvidence}) so both
 * see the same snapshot. Unrecognized schemas and SQLite errors propagate.
 */
export function hrcActuatingEvidenceClause(db: Database): '' | 'AND evidence_origin IS NULL' {
  const columns = db
    .query<{ name: string }, []>('PRAGMA table_info(hrc_events)')
    .all()
    .map((column) => column.name)
  if (!columns.includes('hrc_seq')) {
    throw new Error(
      `hrc_events schema unrecognized: ${columns.length === 0 ? 'table missing' : 'hrc_seq column missing'}`
    )
  }
  return columns.includes('evidence_origin') ? 'AND evidence_origin IS NULL' : ''
}

/** Run schema detection and the guarded read on one read-transaction snapshot. */
export function readHrcEvidence<T>(
  db: Database,
  read: (actuatingClause: '' | 'AND evidence_origin IS NULL') => T
): T {
  return db.transaction(() => read(hrcActuatingEvidenceClause(db))).deferred()
}

/** True when a lifecycle event carries any evidence origin (history, never current work). */
export function hasHrcEvidenceOrigin(event: object): boolean {
  const origin = (event as { evidenceOrigin?: unknown }).evidenceOrigin
  return origin !== undefined && origin !== null
}
