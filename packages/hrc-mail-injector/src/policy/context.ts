import type { HrcBrokerInvocationEventRecord, HrcLifecycleEvent } from 'hrc-core'
import type { HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import type {
  ForeignHome,
  HrcInjectionPort,
  KickerLogLevel,
  KickerStateStore,
} from './contracts.js'
import type { MailKickerLedger } from './ledger/client.js'

/** See `terminal/failure-notices.ts`. */
export type FailureNoticeBackoff = {
  /** The idempotency key that was refused. */
  key: string
  /** HRC answered the stable dispatch with a non-start; the same key only replays it. */
  parked: boolean
  attempts: number
  nextAtMs: number
}

/** One runtime's steer hold; see `drive/steer-hold.ts`. */
export type SteerHold = {
  reason: 'awaiting_input' | 'pane_not_quiescent'
  /** The invocation and broker head the refusal was observed at. */
  invocationId: string | null
  brokerSeq: number
  /** When this hold began, for `STEER_HOLD_MAX_MS`. */
  since: number
  /** Whether `wrkq.kicker.steer_held` has been logged for this hold. */
  announced: boolean
}

/** Internal capability surface shared by the decomposed kicker state machines. */
export type MailKickerContext = {
  /** Kicker-owned state; in its own sqlite file after the Phase 3 store split. */
  readonly store: KickerStateStore
  /** Every HRC-owned read and mutation crosses this boundary. */
  readonly port: HrcInjectionPort
  readonly ledger: MailKickerLedger
  readonly nodeId: string
  readonly foreignHomeMemo: Map<string, ForeignHome>
  readonly enabled: boolean
  readonly sweepIntervalMs: number

  stopping: boolean
  mailKickerSweepTimer: ReturnType<typeof setInterval> | undefined
  mailKickerSweepInFlight: Promise<void> | undefined
  wrkqLedgerTailInFlight: Promise<void> | undefined
  mailKickerColdStartCatchupPending: boolean
  readonly mailKickerPendingTargets: Map<string, HrcMailDriveWakeReason>
  readonly mailKickerTargetOperations: Map<string, Promise<void>>
  readonly mailKickerForeignHomeAnnounced: Map<string, string>
  readonly mailKickerBirthDeferredAnnounced: Map<string, string>
  readonly mailKickerBirthSweepBackoff: Map<string, { attempts: number; nextAtMs: number }>
  /**
   * Sender-failure notices this process could not show, per target, for one
   * dispatch key (runtime + notice set): a different key starts clean.
   */
  readonly mailKickerFailureNoticeBackoff: Map<string, FailureNoticeBackoff>
  readonly mailKickerLapsedRuntimes: Set<string>
  /**
   * In-flight obligation disposals (T-07963, carried into D3). `stop()` drains
   * these before the store closes; every decision inside one is ALSO written
   * durably as it is made, so a stop that beats the drain leaves the reconcile
   * a candidate rather than silence.
   */
  readonly mailKickerDisposalsPending: Set<Promise<void>>
  /** One boot-reconcile report is owed per process (T-07964 §4). */
  mailKickerBootReconcilePending: boolean
  /** Envelopes already named by a stalled-delivery line; one per envelope per process. */
  readonly mailKickerStalledDeliveryAnnounced: Set<string>
  /**
   * Runtimes whose broker advertised `steer` and then refused one AT THE
   * CAPABILITY LAYER — the driver cannot actually do it.
   *
   * D2's "a refused steer becomes an enqueue" is about exactly that case, and
   * only that case. Without the memo the next pass reads the same advertised
   * capability, takes the same door and is refused again — a spin, not a
   * fallback. Process-local because the capability projection is frozen per
   * invocation: a new broker for the seat is a new runtime id and starts
   * trusted again.
   *
   * A TRANSIENT refusal never lands here. `pane_not_quiescent` fires whenever a
   * human is mid-word in the pane, which is routine on a tab seat; memoizing it
   * would degrade that runtime to enqueue for the life of the daemon and defeat
   * steer-first on precisely the seats a person is sitting at.
   */
  readonly mailKickerSteerRefused: Set<string>
  /**
   * Envelopes whose last steer was refused WITHOUT being written by a guarded
   * turn, authority, or capability. Steer is best effort and mail is not: the
   * next pass for that envelope takes the enqueue door, which queues it behind
   * the running turn instead of re-trying a steer into a turn that will keep
   * refusing it (T-08533). Consumed when that pass picks the door;
   * process-local, because a restart that forgets it only costs one more
   * refused steer.
   */
  readonly mailKickerSteerFallback: Set<string>
  /**
   * Per-runtime backoff for a refusal that is about the MOMENT rather than the
   * seat: a transient steer refusal, or a door that threw.
   *
   * Bounded and doubling so a pane somebody is typing into steadily — or a
   * daemon draining for restart — is not hammered, and cleared on a successful
   * landing so a seat that starts accepting deliveries again pays nothing for
   * the interval it did not. Every refusal path is paced through this one map;
   * the drain window that spun five times in a second is what it is for.
   */
  readonly mailKickerDeliveryBackoff: Map<string, number>
  /**
   * Per-runtime steer holds (T-10233): a seat parked on human input, by its
   * `awaiting_input` status or by a `pane_not_quiescent` refusal with nothing
   * observed on the seat since. While one stands a drive pass submits nothing
   * into that seat, because every steer is a new HRC submission and run and
   * the pane refuses it unwritten. See `drive/steer-hold.ts`.
   */
  readonly mailKickerSteerHold: Map<string, SteerHold>

  log(level: KickerLogLevel, event: string, detail: Record<string, unknown>): void

  wake(targetSessionRef: string, reason: HrcMailDriveWakeReason): void
  drainTarget(targetSessionRef: string): Promise<void>
  runSweepOnce(): Promise<void>
  runTailOnce(): Promise<void>
  observeLifecycleEvent(event: HrcLifecycleEvent): void
  observeBrokerEvent(event: HrcBrokerInvocationEventRecord): void
}
