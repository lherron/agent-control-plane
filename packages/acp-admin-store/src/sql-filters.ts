export function buildWhereClause(
  filters: ReadonlyArray<readonly [column: string, op: string, value: string | undefined]>
): { whereClause: string; values: string[] } {
  const clauses: string[] = []
  const values: string[] = []
  for (const [column, op, value] of filters) {
    if (value === undefined) continue
    clauses.push(`${column} ${op} ?`)
    values.push(value)
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return { whereClause, values }
}
