// Both Bun and the store adapters expose this small read port.
type DatabaseReader = {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
}
function boundedDeadline(now: number, deadlines: number[], cadenceMs: number): number {
  // A scan has already attempted overdue work. Keep its retry cadence instead
  // of spinning on a deadline that cannot yet be settled.
  return Math.max(
    1,
    Math.min(60_000, ...deadlines.map((deadline) => (deadline > now ? deadline - now : cadenceMs)))
  )
}

export function inputQueueDelayMs(
  db: DatabaseReader,
  input: {
    now: number
    cadenceMs: number
    leaseTimeoutMs: number
    ttlMs?: number | undefined
  }
): number {
  const rows = db
    .prepare(
      "SELECT status, not_before_at, leased_at, created_at FROM input_queue WHERE status IN ('queued', 'leased', 'dispatching', 'running')"
    )
    .all() as {
    status: string
    not_before_at: string | null
    leased_at: string | null
    created_at: string
  }[]
  const deadlines: number[] = []
  for (const row of rows) {
    if (
      row.status === 'queued' &&
      row.not_before_at !== null &&
      Date.parse(row.not_before_at) > input.now
    ) {
      deadlines.push(Date.parse(row.not_before_at))
    } else {
      deadlines.push(input.now + input.cadenceMs)
    }
    if (row.leased_at !== null && row.status === 'leased')
      deadlines.push(Date.parse(row.leased_at) + input.leaseTimeoutMs)
    if (input.ttlMs !== undefined) deadlines.push(Date.parse(row.created_at) + input.ttlMs)
  }
  // Application outcomes have no automatic two-second HRC ledger consumer.
  // Their commits wake the dispatcher; orphan inspection uses the minute backstop.
  return boundedDeadline(input.now, deadlines, input.cadenceMs)
}

export function jobsDelayMs(
  db: DatabaseReader,
  input: {
    now: number
    cadenceMs: number
    scheduleDeadlines: number[]
    nodeId?: string | undefined
  }
): number {
  const deadlines = [...input.scheduleDeadlines]
  const rows = db
    .prepare(
      "SELECT status, execution_node_id, lease_expires_at FROM job_runs WHERE status IN ('pending', 'claimed', 'dispatched')"
    )
    .all() as {
    status: string
    execution_node_id: string | null
    lease_expires_at: string | null
  }[]
  for (const row of rows) {
    if (input.nodeId !== undefined && row.execution_node_id !== input.nodeId) continue
    if (
      row.status === 'claimed' &&
      row.lease_expires_at !== null &&
      Date.parse(row.lease_expires_at) > input.now
    )
      deadlines.push(Date.parse(row.lease_expires_at))
    else deadlines.push(input.now + input.cadenceMs)
  }
  const inbox = db
    .prepare(
      "SELECT status, lease_expires_at FROM event_inbox WHERE status IN ('pending', 'leased')"
    )
    .all() as { status: string; lease_expires_at: string | null }[]
  for (const row of inbox)
    deadlines.push(
      row.status === 'leased' && row.lease_expires_at !== null
        ? Date.parse(row.lease_expires_at)
        : input.now + input.cadenceMs
    )
  const retries = db
    .prepare(
      "SELECT next_attempt_at FROM job_output_sink_attempts WHERE status <> 'succeeded' AND next_attempt_at IS NOT NULL"
    )
    .all() as { next_attempt_at: string }[]
  for (const row of retries)
    if (Date.parse(row.next_attempt_at) > input.now) deadlines.push(Date.parse(row.next_attempt_at))
  return boundedDeadline(input.now, deadlines, input.cadenceMs)
}
