import type { RepoContext } from './shared.js'

type SessionAdmissionSequenceRow = {
  next_seq: number
}

export class SessionAdmissionSequenceRepo {
  constructor(private readonly context: RepoContext) {}

  reserve(input: { scopeRef: string; laneRef: string }): number {
    const now = new Date().toISOString()
    const row = this.context.sqlite
      .prepare(
        `SELECT next_seq
           FROM session_admission_sequence
          WHERE scope_ref = ?
            AND lane_ref = ?`
      )
      .get(input.scopeRef, input.laneRef) as SessionAdmissionSequenceRow | undefined

    const seq = row?.next_seq ?? 1
    this.context.sqlite
      .prepare(
        `INSERT INTO session_admission_sequence (scope_ref, lane_ref, next_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_ref, lane_ref)
         DO UPDATE SET next_seq = excluded.next_seq, updated_at = excluded.updated_at`
      )
      .run(input.scopeRef, input.laneRef, seq + 1, now)

    return seq
  }
}
