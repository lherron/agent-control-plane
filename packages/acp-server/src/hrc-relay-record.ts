import type { HrcBoundedEventStreamRecord } from 'hrc-core'

/**
 * T-10418: the terminal control HRC's scope-home relay emits when the home's
 * stream ends without its own terminal. Declared here so ACP builds against an
 * HRC tuple that predates it; once the tuple carries it the union is a no-op.
 * Like `ready`, it never advances a cursor.
 */
export type HrcHomeUnreachableRecord = {
  type: 'home_unreachable'
  homeNodeId: string
  retryable: true
  reason: 'disconnected' | 'idle_timeout' | 'malformed' | 'oversize'
}

export type RelayedBoundedEventRecord = HrcBoundedEventStreamRecord | HrcHomeUnreachableRecord
