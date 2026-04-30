/**
 * Internal types for the gateway-ios reducer pipeline.
 *
 * ReducerInput is the canonical input union for P2's event-reducer.
 * It accepts both HRC lifecycle events and durable hrcchat messages,
 * allowing the reducer to produce timeline frames from either source.
 *
 * The shape is intentionally loose enough that P1's server-side paging
 * additions (backwards paging, sessionRef filtering) can feed results
 * into the reducer without contract churn.
 */

import type { HrcLifecycleEvent, HrcMessageRecord } from 'hrc-core'

/** A single input to the reducer — either an HRC lifecycle event or a durable message. */
export type ReducerInput =
  | { kind: 'event'; event: HrcLifecycleEvent }
  | { kind: 'message'; message: HrcMessageRecord }
