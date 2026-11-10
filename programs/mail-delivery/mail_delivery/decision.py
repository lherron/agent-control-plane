"""A side-effect-free snapshot of today's injector policy.

All timestamps are epoch milliseconds; now is supplied by the caller. None is
unknown, never false/zero. Explicit 'none' records mean the owner confirmed no
intent, presentation, or refusal. Inputs are observations, not inferred defaults.
Decision.effects describes auxiliary policy work; this module performs none.
"""
from dataclasses import dataclass
from . import timings as t


@dataclass(frozen=True)
class Intent:
    status: str | None = None  # none / open
    door: str | None = None
    submitted_at: int | None = None
    landing: str | None = None  # none / landed / started / uncertain
    terminal_reason: str | None = None
    cleanup_done: bool | None = None
    has_runtime: bool | None = None
    live_digest_siblings: bool | None = None
    scope_live: bool | None = None  # scoped live inventory for stalled launch recovery
    prior_launch_failures: int | None = None


@dataclass(frozen=True)
class Presentation:
    status: str | None = None  # none / landed
    runtime_matches: bool | None = None  # newest receipt still names this runtime
    runtime_live: bool | None = None
    operator_held: bool | None = None
    landing_seq: int | None = None
    terminal_seq: int | None = None  # -1 means no later terminal observed
    terminal_at: int | None = None
    reminder: str | None = None  # none / armed / landed
    remind_at: int | None = None
    reminder_landing_seq: int | None = None


@dataclass(frozen=True)
class Retry:
    kind: str | None = None  # none / launch / sweep / not_hosted / deterministic / participant_only / participant_turn
    attempts: int | None = None
    last_at: int | None = None
    host_reason: str | None = None
    host_since: int | None = None  # persisted first refusal; only consecutive host-class failures


@dataclass(frozen=True)
class Refusal:
    kind: str | None = None  # none / transient / capability / policy / authority
    attempts: int | None = None
    last_at: int | None = None


@dataclass(frozen=True)
class Envelope:
    id: str
    obligation: str | None = None
    state: str | None = None  # pending / presented / deferred / terminal
    created_at: int | None = None
    delivery: str | None = None  # normal / hold (on envelope, not seat)
    presented_before: bool | None = None
    retry_at: int | None = None
    repend_attempts: int | None = None
    repend_last_at: int | None = None
    intent: Intent | None = None
    presentation: Presentation | None = None
    birth_retry: Retry | None = None
    steer_refusal: Refusal | None = None
    non_landing_strikes: int | None = None  # this envelope AND runtime
    kind: str | None = None  # envelope / failure_notice (target is sender for notices)
    notice_attempts: int | None = None  # current owed notice set, across runtime changes
    notice_last_at: int | None = None
    notice_parked: bool | None = None  # non-start replay on this exact runtime


@dataclass(frozen=True)
class Seat:
    home: str | None = None  # local / foreign / unbound / unavailable
    live_elsewhere: bool | None = None
    federation_complete: bool | None = None
    session_exists: bool | None = None
    state: str | None = None  # exact ObservedBrokerSeat.state
    steer_capable: bool | None = None  # frozen invocation hello, not installed driver
    steer_capability_refused: bool | None = None  # memo for this runtime
    awaiting_input: bool | None = None
    quiet_hold: bool | None = None
    quiet_since: int | None = None
    quiet_moved: bool | None = None  # meaningful broker activity, excludes rejection bookkeeping
    preempt_admission: str | None = None  # authorized / denied / preempt-unsupported
    target_is_task: bool | None = None
    task_read: str | None = None  # ok / failed / not_applicable
    task_state: str | None = None


@dataclass(frozen=True)
class Runtime:
    id: str | None = None
    status: str | None = None
    created_at: int | None = None  # code explicitly falls back to envelope age when unknown


@dataclass(frozen=True)
class Decision:
    action: str
    reason: str
    missing_fact: str | None = None
    retry_at: int | None = None
    form: str = 'full'
    effects: tuple[str, ...] = ()


class MissingFact(Exception):
    pass


def fact(value, name):
    if value is None:
        raise MissingFact(name)
    return value


def decide(envelope: Envelope, seat: Seat, runtime: Runtime, now: int) -> Decision:
    """Decide from explicit facts only. No I/O, mutations, clock reads or kernel calls."""
    try:
        return _decide(envelope, seat, runtime, now)
    except MissingFact as missing:
        return Decision('cannot_decide', 'missing_fact', missing_fact=str(missing))


def _decide(e, s, r, now):
    # facts/ and target-driver.ts: placement fences precede every door.
    home = fact(s.home, 'seat.home')
    if home == 'foreign':
        return Decision('skip', 'foreign_home')
    if home == 'unavailable':
        return Decision('defer', 'federation_unavailable')
    if fact(s.live_elsewhere, 'seat.live_elsewhere'):
        return Decision('skip', 'live_elsewhere')

    obligation = fact(e.obligation, 'envelope.obligation')
    if fact(e.kind, 'envelope.kind') == 'failure_notice':
        return _notice(e, s, now)
    state = fact(e.state, 'envelope.state')
    intent = fact(e.intent, 'envelope.intent')
    intent_status = fact(intent.status, 'intent.status')
    if state == 'terminal':
        effects = ()
        if intent_status == 'open' and not fact(intent.cleanup_done, 'intent.cleanup_done'):
            if fact(intent.terminal_reason, 'intent.terminal_reason') != 'fyi_presented':
                if fact(intent.door, 'intent.door') != 'launch' and fact(intent.has_runtime, 'intent.has_runtime'):
                    if not fact(intent.live_digest_siblings, 'intent.live_digest_siblings'):
                        effects = ('withdraw',)
        return Decision('hold', 'envelope_terminal', effects=effects)
    if state == 'deferred':
        retry = fact(e.retry_at, 'envelope.retry_at')
        # wake/deferred.ts: wait until wrkq's whole-second comparison is safe.
        due = ((retry + t.DEFERRED_SECOND_MS - 1) // t.DEFERRED_SECOND_MS + 1) * t.DEFERRED_SECOND_MS
        if now < due:
            return Decision('defer', 'recipient_deferred', retry_at=due)
        attempts = fact(e.repend_attempts, 'envelope.repend_attempts')
        if attempts:
            retry_due = fact(e.repend_last_at, 'envelope.repend_last_at') + t.REPEND_BACKOFF_MS[min(attempts - 1, 2)]
            if now < retry_due:
                return Decision('defer', 'repend_backoff', retry_at=retry_due)
        return Decision('defer', 'repend_required', effects=('repend_read',))
    if intent_status == 'open':
        age = now - fact(intent.submitted_at, 'intent.submitted_at')
        landing = fact(intent.landing, 'intent.landing')
        effects = ()
        if landing == 'none' and age >= t.STALLED_DELIVERY_THRESHOLD_MS:
            if fact(intent.door, 'intent.door') == 'launch' and not fact(intent.scope_live, 'intent.scope_live'):
                if state == 'pending' and not fact(e.presented_before, 'envelope.presented_before'):
                    attempts = fact(intent.prior_launch_failures, 'intent.prior_launch_failures') + 1
                    if attempts >= t.LAUNCH_MAX_FAILURES:
                        return Decision('fail', 'undeliverable', effects=('recover_launch',))
                    return Decision('defer', 'stalled_launch_recovery',
                                    retry_at=now + t.BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1),
                                    effects=('recover_launch',))
            effects += ('stalled',)
        if landing in ('none', 'uncertain') and age >= t.KICKER_SUBMISSION_TTL_MS:
            effects += ('ttl_uncertain',)
        return Decision('hold', 'intent_open', effects=effects)
    form = 'full'
    if state == 'presented':
        after = _after_delivery(fact(e.presentation, 'envelope.presentation'), now)
        if after is not None:
            return after
        form = 'reminder'
    elif state == 'pending':
        if fact(e.presented_before, 'envelope.presented_before'):
            form = 'defer-retry'
    else:
        return Decision('cannot_decide', 'unknown_state', missing_fact='envelope.state')
    if fact(e.non_landing_strikes, 'envelope.non_landing_strikes') >= t.KICKER_MAX_NON_LANDING_STRIKES:
        return Decision('fail', 'non_landing_strikes')
    retry = _birth_retry(fact(e.birth_retry, 'envelope.birth_retry'), e, s, now)
    if retry is not None:
        return retry
    session = fact(s.session_exists, 'seat.session_exists')
    if not session:
        return (Decision('launch', 'summoning_mail', form=form) if obligation in ('reply_required', 'notify')
                else Decision('hold', 'fyi_no_session'))
    seat_state = fact(s.state, 'seat.state')
    if seat_state == 'absent':
        if obligation in ('reply_required', 'notify'):
            return Decision('launch', 'summoning_mail', form=form)
        if fact(s.target_is_task, 'seat.target_is_task'):
            task_read = fact(s.task_read, 'seat.task_read')
            if task_read == 'ok' and fact(s.task_state, 'seat.task_state') in (
                    'completed', 'cancelled', 'archived', 'deleted'):
                return Decision('fail', 'target_task_terminal')
        if form == 'full' and now - fact(e.created_at, 'envelope.created_at') > t.BACKLOG_FYI_AGE_MS:
            form = 'digest'
        if fact(e.delivery, 'envelope.delivery') == 'hold' and form != 'digest':
            if fact(s.preempt_admission, 'seat.preempt_admission') == 'authorized':
                return Decision('preempt', 'hold_authorized', form=form)
            return Decision('enqueue', 'hold_refused_authority', form=form)
        return Decision('enqueue', 'fyi_existing_session', form=form)
    if seat_state in ('starting', 'stopping', 'unavailable', 'turn-observed', 'terminal'):
        return Decision('defer', 'seat_' + seat_state)
    if seat_state not in ('idle', 'turn-active'):
        return Decision('cannot_decide', 'unknown_seat_state', missing_fact='seat.state')
    capable = fact(s.steer_capable, 'seat.steer_capable')
    if capable:
        if fact(s.awaiting_input, 'seat.awaiting_input'):
            return Decision('hold', 'awaiting_input')
        if fact(s.quiet_hold, 'seat.quiet_hold'):
            if not fact(s.quiet_moved, 'seat.quiet_moved') and now - fact(s.quiet_since, 'seat.quiet_since') < t.STEER_HOLD_MAX_MS:
                return Decision('hold', 'pane_not_quiescent')
    if obligation == 'fyi' and form == 'full':
        created = fact(e.created_at, 'envelope.created_at')
        if now - created > t.BACKLOG_FYI_AGE_MS or (r.created_at is not None and created < r.created_at):
            form = 'digest'
    delivery = fact(e.delivery, 'envelope.delivery')
    hold = delivery == 'hold' and form != 'digest'
    if hold and fact(s.preempt_admission, 'seat.preempt_admission') == 'authorized':
        return Decision('preempt', 'hold_authorized', form=form)
    refusal = fact(e.steer_refusal, 'envelope.steer_refusal')
    refusal_kind = fact(refusal.kind, 'steer_refusal.kind')
    if capable and not fact(s.steer_capability_refused, 'seat.steer_capability_refused') and refusal_kind not in ('capability', 'policy', 'authority'):
        if refusal_kind == 'transient':
            due = fact(refusal.last_at, 'steer_refusal.last_at') + t.steer_retry_ms(fact(refusal.attempts, 'steer_refusal.attempts'))
            if now < due:
                return Decision('defer', 'steer_backoff', retry_at=due, form=form)
        return Decision('steer', 'hold_refused_authority' if hold else 'steer_capable', form=form)
    return Decision('enqueue', 'hold_refused_authority' if hold else 'enqueue_required', form=form)


def _after_delivery(p, now):
    if not fact(p.runtime_matches, 'presentation.runtime_matches'):
        return Decision('hold', 'presentation_superseded')
    if fact(p.operator_held, 'presentation.operator_held'):
        return Decision('hold', 'awaiting_operator')
    if not fact(p.runtime_live, 'presentation.runtime_live'):
        return Decision('fail', 'runtime_terminated')
    terminal = fact(p.terminal_seq, 'presentation.terminal_seq')
    reminder = fact(p.reminder, 'presentation.reminder')
    if reminder == 'landed':
        if fact(p.reminder_landing_seq, 'presentation.reminder_landing_seq') < terminal:
            return Decision('hold', 'awaiting_operator')
        return Decision('hold', 'reminder_pending')
    if reminder == 'armed':
        due = fact(p.remind_at, 'presentation.remind_at')
        if now < due:
            return Decision('defer', 'reminder_wait', retry_at=due)
        return None  # same runtime's due reminder takes its ordinary door
    if terminal < 0 or fact(p.landing_seq, 'presentation.landing_seq') >= terminal:
        return Decision('hold', 'awaiting_turn')
    # disposal.ts arms at observation time, even when the event arrived late.
    due = now + t.REMINDER_HOLD_MS
    return Decision('defer', 'reminder_wait', retry_at=due, effects=('arm_reminder',))


def _birth_retry(b, e, s, now):
    kind = fact(b.kind, 'birth_retry.kind')
    if kind == 'none':
        return None
    # Birth exhaustion may only fail never-presented pending mail.
    if e.state != 'pending' or fact(e.presented_before, 'envelope.presented_before'):
        return None
    if kind == 'participant_only' and fact(s.federation_complete, 'seat.federation_complete'):
        return Decision('fail', 'undeliverable')
    if kind == 'deterministic':
        return Decision('fail', 'undeliverable')
    attempts = fact(b.attempts, 'birth_retry.attempts')
    participant = fact(b.host_reason, 'birth_retry.host_reason') in t.PARTICIPANT_HOST_REASONS
    if kind == 'participant_turn':
        due = fact(b.last_at, 'birth_retry.last_at') + t.participant_host_retry_ms(attempts)
        return Decision('defer', 'birth_backoff', retry_at=due) if now < due else None
    if participant:
        since = fact(b.host_since, 'birth_retry.host_since')
        if now - since >= t.PARTICIPANT_HOST_GIVE_UP_MS:
            return Decision('fail', 'undeliverable')
        delay = t.participant_host_retry_ms(attempts)
    else:
        limit = t.LAUNCH_MAX_FAILURES if kind == 'launch' else t.BIRTH_SWEEP_MAX_REFUSALS
        if attempts >= limit:
            return Decision('fail', 'undeliverable')
        base = t.BIRTH_SWEEP_NOT_HOSTED_BASE_MS if kind in ('not_hosted', 'participant_only') else t.BIRTH_SWEEP_BACKOFF_BASE_MS
        delay = base * 2 ** max(attempts - 1, 0)
    due = fact(b.last_at, 'birth_retry.last_at') + delay
    if now < due:
        return Decision('defer', 'birth_backoff', retry_at=due)
    return None


def _notice(e, s, now):
    if e.obligation != 'reply_required':
        return Decision('hold', 'notice_not_owed')
    if fact(s.state, 'seat.state') not in ('idle', 'turn-active'):
        return Decision('hold', 'notice_no_live_seat')
    attempts = fact(e.notice_attempts, 'envelope.notice_attempts')
    if attempts >= t.FAILURE_NOTICE_MAX_ATTEMPTS:
        return Decision('hold', 'notice_exhausted')
    if fact(e.notice_parked, 'envelope.notice_parked'):
        return Decision('hold', 'notice_parked')
    if attempts:
        due = fact(e.notice_last_at, 'envelope.notice_last_at') + t.failure_notice_retry_ms(attempts)
        if now < due:
            return Decision('defer', 'notice_backoff', retry_at=due)
    return Decision('enqueue', 'failure_notice')
