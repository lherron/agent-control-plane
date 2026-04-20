import type { Database } from 'bun:sqlite'

type SequenceRow = {
  last_seq: number
}

export function nextProjectSequence(sqlite: Database, projectId: string): number {
  const existing = sqlite
    .query<SequenceRow, [string]>('SELECT last_seq FROM project_seq_counters WHERE project_id = ?')
    .get(projectId)

  if (!existing) {
    sqlite
      .query('INSERT INTO project_seq_counters (project_id, last_seq) VALUES (?, 1)')
      .run(projectId)
    return 1
  }

  const next = existing.last_seq + 1
  sqlite
    .query('UPDATE project_seq_counters SET last_seq = ? WHERE project_id = ?')
    .run(next, projectId)
  return next
}
