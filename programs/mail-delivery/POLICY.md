# Policy readback and adapter facts

T-13270 update, 2026-11-10: Lance ruled this is a **port**, retaining the
injector database and existing HRC/wrkq reads. The historical inventory below
is a list of input fields, not requests for new owner APIs. `port_inputs.py`
now supplies store-backed facts and native HRC probes; `memos.py` supplies
process-local outcomes from the injector log and observes broker movement.
No section 5 redesign is enabled. An input gap is a shadow defect, not an ask
against HRC or wrkq.

Like the injector’s failed-drain boundary, an exception while deciding one envelope logs `shadow.decision_failed` with its traceback, skips that observation, and lets the next envelope run; the scorer reports those failures separately, while errors outside envelope work still escape to the host.

The first installed run found legacy EN-00738: wrkq has a presentation receipt
without runtimeId and max3 has no local presentation row. The injector's
`readActionableEnvelopes` excludes it because there is no due local reminder.
The port now uses confirmed `Presentation(status='none')` and returns
`hold/no_due_reminder`, rather than calling that a missing owner field.

The HRC terminal classification includes stopped, failed, disposed and exited,
as well as terminated, crashed, dead and stale. The adapter uses the complete
`hrc-core/monitor/status-levels.ts` set and excludes detached for seat selection.
Durable launch exhaustion precedes process-local pacing, as in target-driver.

Live comparison additionally joins injector JSON-log decisions. A missing
same-state decision is evaluated over a bounded evidence window: a closed hold/defer window without an injector act agrees by inaction, while an unmatched act is a defect; only open windows stay pending_evidence. Daily gate counts use envelopes
created that UTC day, with older backlog alongside. No full-body admission is
compared to a presented/intent-held observation. Log-fed memo dependencies and
broker movement are tagged. See README for exact reads and time windows.

First-delivery reconstruction runs from injector admission evidence independently of open-envelope visibility, using bounded watch history for as-of runtime status and labelled already-read invocation proof for capability.

The remaining text is the T-13192 source readback and input inventory:

T-13192, read against the canonical injector source on 2026-11-10. This is the
first owner-field inventory, not a claim that a kernel read was performed. The
assignment explicitly excludes kernel calls. Input adapters and the live loop
come later. No section 5 changes or dropped presentation/store migration rules
are enabled.

## Optional facts

All observation fields except the envelope identifier default to unknown.
The function asks only for facts relevant to the selected rule path. Owners
must distinguish a confirmed empty record from unavailable data. Fact names
below correspond to the dataclasses in `decision.py`.

| Observation | Fields | Owner / current gap |
| --- | --- | --- |
| Envelope | obligation, state, created_at, delivery, presented_before, retry_at, repend_attempts, repend_last_at, kind | wrkq: include hold delivery, deferral deadline and presentation history; kind is caller context for mail vs sender notice |
| Placement / seat | home, live_elsewhere, federation_complete, session_exists, state | HRC: keyed home, session and live inventory; broker probe is distinct from summary status |
| Steer / interruption | steer_capable, steer_capability_refused, awaiting_input, quiet_hold, quiet_since, quiet_moved, preempt_admission | HRC probe/admission plus injector memos: frozen invocation capability, runtime capability rejection, meaningful activity since first quiet refusal, interruption authority |
| Task target | target_is_task, task_read, task_state | Parsed target + wrkq task owner; explicit failed read preserves injector fallback; unknown read is not failure |
| Runtime | id, status, created_at | HRC; id/status are available contextual fields, receipt runtime liveness is supplied separately; unknown birth explicitly falls back to envelope age as injector does |
| Open intent | intent.status, door, submitted_at, landing, terminal_reason, cleanup_done, has_runtime, live_digest_siblings, scope_live, prior_launch_failures | Injector private delivery evidence today; requires future owner-backed fence/landing/cleanup and digest membership evidence |
| Presentation | presentation.status, runtime_matches, runtime_live, operator_held, landing_seq, terminal_seq, terminal_at, reminder, remind_at, reminder_landing_seq | wrkq receipts plus injector presentation state; needs durable reminder and operator disposition, correlated landing/terminal order; -1 terminal_seq explicitly means no terminal observed |
| Birth refusal | birth_retry.kind, attempts, last_at, host_reason, host_since | Injector private persisted launch failures and process-local sweep backoff; host_since is persisted first consecutive host-class refusal, not process start; ordinary host_reason must be explicit |
| Steer refusal | steer_refusal.kind, attempts, last_at | Injector per-envelope fallback, per-runtime rejection/backoff and correlated proof of no write; kind is normalized capability/policy/authority/transient/none |
| Strike budget | non_landing_strikes | Injector: per envelope AND runtime, charged only on positively proven no-write evidence |
| Failure notices | notice_attempts, notice_last_at, notice_parked | Injector: budget belongs to current complete owed notice set across reseats; parked replay belongs to the current runtime; notice inputs address the sender |

`runtime.created_at` is the explicit exception to unknown => cannot_decide:
`drive/presentation.ts:isBacklogFyi` falls back to age when birth is unknown.
Nested records are optional; a missing record returns its own dotted field
name before any contained fields. No process-local histories are reconstructed
from summary state. `Presentation.status`, terminal_at and Runtime id/status
are contextual metadata; relevant rule facts are checked independently.

## Differences and qualifications to brief section 4

1. **Hold is an envelope delivery request, not a seat state.**
   `drive/delivery.ts:deliverToSeat` checks `envelope.delivery === 'hold'` and
   asks `preemptAdmission`; denial/unsupported falls through to the normal door
   with `hold_refused_authority`. A steer-held reader is checked before this.
2. **Idle requires steer capability too.** `drive/delivery.ts:doorFor` steers
   both idle and active only with frozen capability, no runtime capability
   refusal, and no envelope fallback. Otherwise it enqueues.
3. **Not every unwritten steer refusal enqueues.** `drive/landing.ts` falls
   back only for capability/policy/authority. Transient `pane_not_quiescent` or
   invalid-state refusals keep the steer retry (2 s doubling to 30 s).
4. **Awaiting-input has no ten-minute ceiling.** `drive/steer-hold.ts` holds
   until awaiting_input clears. Only quiet-pane refusal holds have the ceiling,
   released earlier by meaningful broker movement. Both hold only steer-capable
   idle/active seats, not enqueue-only drivers.
5. **The reminder's second strike is correlated, not a terminal count.**
   `terminal/disposal.ts` requires the reminder's landing sequence to precede
   the later terminal. An armed/unlanded reminder, a terminal before first
   landing, or a superseded receipt is not a second strike. Initial arming is
   60 s from processing the observation, not from the event timestamp.
6. **An operator-held obligation survives runtime death.**
   `terminal/runtime-lapse.ts` excludes durable `held:awaiting_operator` rows.
7. **Terminal queue withdrawal has exceptions.** `wake/ledger-tail.ts` leaves
   auto-acknowledged `fyi_presented` submissions, live digest siblings, launch
   intents, already-cleaned intents, and runtime-less intents alone. Only the
   last terminal digest member can withdraw its shared broker submission.
8. **TTL is not permission to redeliver.** `drive/reconcile.ts` retains open
   intent uncertainty at 30 min; expiry/loss/death does not release a possible
   write fence. Ordinary five-minute stalled reporting is diagnostic. A stalled launch with no live scope is the exception below.
9. **Failure notice first retry is immediate.** `terminal/failure-notices.ts`
   uses delay 0 after the first failed call, then 30 s doubling to 1 h. A
   replayed non-start parks that runtime; eight attempts park the notice set.
10. **Incomplete federated inventory does not universally block birth.**
    `drive/target-driver.ts:launchHereOrSkip` attempts the birth when the read
    returned no foreign live home, even if `complete` is false. A failed read
    defers. Completeness is required before a participant-only refusal can be
    called deterministically unseated and failed. This is narrower than the
    brief's “a peer that does not answer is never read as absent.”
11. **Deferred wake adds a whole-second margin.** `wake/deferred.ts` schedules
    ceil(retryAt / 1000) * 1000 + 1000 and requires a pending-view confirmation;
    unsuccessful confirmations retry 1, 2, then 5 s. Shadow emits repend_required
    and never performs that read (it has write side effects today).
12. **Backlog only applies to first-presentation legacy fyi.**
    `drive/presentation.ts` uses strictly greater than 15 min or strictly before
    runtime birth. Notify, reminders, and deferred retry pointers stay separate.
    An absent seat can still receive an age-based digest via enqueue.

13. **Stalled launch recovery is an action, not merely a log line.**
    `diagnostics/stranded.ts:reportStalledDeliveries` calls recoverFailedLaunch
    after five minutes when scoped live inventory finds no live runtime. The
    launch intent is released, its failure charged, and the ordinary 60 s
    doubling retry/three-failure bound applies. Other doors keep their fences.
14. **Participant turn retries have no persisted ten-minute launch clock.**
    `drive/delivery.ts:retryParkedParticipantSoon` calls
    `wake/birth-retry.ts:scheduleParticipantHostRetry` for unwritten turn-door
    refusals; it schedules the 10/20/40/60 s retry without recording a persisted
    first-refusal give-up clock. `birth_retry.kind='participant_turn'` captures
    that distinction; only launch-failure records use the ten-minute bound.

## Real store limits

Observed max3 tables before building a fixture: both tables key on envelope_id
and upsert their latest record. Diagnostic outcomes were admitted, seat_starting,
seat_turn-observed, seat_unavailable; doors steer, enqueue, launch, invoke.
All are mapped (admitted only with correlated same-runtime intent). The program
also recognizes the explicit seat_stopping and broker_probe_failed diagnostic
recording paths from `target-driver.ts`.

Contrary to the scoring brief's assumption, **hold and skip are not per-envelope
drive diagnostics in this implementation**. `steer_held`, `skipped`, and other
completion outcomes are target-level log lines, not writes to this table.
Consequently hold/skip agreement cannot be measured using these two tables
alone. The scorer lists any unknown value and returns cannot_decide rather than
inventing a mapping. Admitted timestamps are diagnostic observation times when
selected; intent submitted_at remains separately available as admission time.
Historical decisions overwritten by later drives cannot be recovered here.

EN-50915 reconstruction input ruling: a ready watch's missing scope is known
absence; an unready history is `history_cold`. Missing home evidence may use
the same existing locate GET, labelled before/after admission with timestamp
proof recorded. No reconstruction preempt-admission probe is permitted.

EN-50935 permits a later ordinary seat probe only for the same runtime,
generation and invocation proven active before admission. Capability classes
are invocation declarations, independent of idle/active state; as-of seat state
still comes from history. Cold proof may use an earlier anonymous broker record
and must retain its seq/time; unavailable or changed identity stays a named gap.
