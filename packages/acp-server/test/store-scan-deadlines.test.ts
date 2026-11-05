import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { inputQueueDelayMs, jobsDelayMs } from '../src/integration/store-scan-deadlines.js'

test('queue future retry and lease expiry shorten the backstop without a commit', () => {
  const db = new Database(':memory:')
  db.exec(
    'CREATE TABLE input_queue(status TEXT, not_before_at TEXT, leased_at TEXT, created_at TEXT); CREATE TABLE input_applications(status TEXT)'
  )
  const now = Date.now()
  const iso = (offset: number) => new Date(now + offset).toISOString()
  expect(inputQueueDelayMs(db, { now, cadenceMs: 2000, leaseTimeoutMs: 10000 })).toBe(60000)
  db.prepare('INSERT INTO input_queue VALUES (?, ?, ?, ?)').run('queued', iso(250), null, iso(0))
  expect(inputQueueDelayMs(db, { now, cadenceMs: 2000, leaseTimeoutMs: 10000 })).toBe(250)
  db.exec('DELETE FROM input_queue')
  db.prepare('INSERT INTO input_queue VALUES (?, ?, ?, ?)').run(
    'leased',
    null,
    iso(-9900),
    iso(-10000)
  )
  expect(inputQueueDelayMs(db, { now, cadenceMs: 2000, leaseTimeoutMs: 10000 })).toBe(100)
  db.close()
})

test('job next due is its deadline; externally driven work retains cadence', () => {
  const db = new Database(':memory:')
  db.exec(
    'CREATE TABLE job_runs(status TEXT, execution_node_id TEXT, lease_expires_at TEXT); CREATE TABLE event_inbox(status TEXT, lease_expires_at TEXT); CREATE TABLE job_output_sink_attempts(status TEXT, next_attempt_at TEXT)'
  )
  const now = Date.now()
  const input = { now, cadenceMs: 5000, scheduleDeadlines: [now + 30000], nodeId: 'max3' }
  expect(jobsDelayMs(db, input)).toBe(30000)
  db.prepare('INSERT INTO job_runs VALUES (?, ?, ?)').run('dispatched', 'max3', null)
  expect(jobsDelayMs(db, input)).toBe(5000)
  db.close()
})
