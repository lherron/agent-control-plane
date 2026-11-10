"""Injector timings, in milliseconds unless named TICKS (seconds).

Source paths below are relative to packages/hrc-mail-injector/src/policy/.
No scheduler or clock is owned by this package.
"""

# internal.ts: constants of the same names.
REMINDER_HOLD_MS = 60_000
STEER_RETRY_BASE_MS = 2_000
STEER_RETRY_MAX_MS = 30_000
STEER_HOLD_MAX_MS = 600_000
KICKER_MAX_NON_LANDING_STRIKES = 3
KICKER_SUBMISSION_TTL_MS = 1_800_000
LEDGER_SWEEP_TICKS = 300
REMINDER_CHECK_TICKS = 30
PERIODIC_QUIET_BACKSTOP_MS = 600_000
BIRTH_SWEEP_BACKOFF_BASE_MS = 60_000
BIRTH_SWEEP_NOT_HOSTED_BASE_MS = 900_000
BIRTH_SWEEP_MAX_REFUSALS = 5
PARTICIPANT_HOST_FIRST_RETRY_MS = 10_000
PARTICIPANT_HOST_RETRY_CAP_MS = 60_000
PARTICIPANT_HOST_GIVE_UP_MS = 600_000
FAILURE_NOTICE_BACKOFF_BASE_MS = 30_000
FAILURE_NOTICE_BACKOFF_MAX_MS = 3_600_000
FAILURE_NOTICE_MAX_ATTEMPTS = 8
STALLED_DELIVERY_THRESHOLD_MS = 300_000
# drive/presentation.ts: BACKLOG_FYI_AGE_MS.
BACKLOG_FYI_AGE_MS = 900_000
# wake/deferred.ts: REPEND_BACKOFF_MS, RETRY_MS, and observeDeferredWake rounding.
REPEND_BACKOFF_MS = (1_000, 2_000, 5_000)
DEFERRED_RETRY_MS = 30_000
DEFERRED_SECOND_MS = 1_000
# facts/hrc-facts.ts: constants of the same names.
FOREIGN_HOME_TTL_MS = 300_000
DESIGNATIONS_TTL_MS = 300_000
# controller.ts: ledgerLoop literal commitWait timeoutMs (upper bound).
LEDGER_WAIT_TIMEOUT_MS = 25_000
# drive/launch-recovery.ts: failExhaustedLaunch's literal attempts >= 3.
LAUNCH_MAX_FAILURES = 3
# drive/authority.ts: PARTICIPANT_HOST_REFUSAL_REASONS.
PARTICIPANT_HOST_REASONS = frozenset((
    'host_absent', 'participant_attempt_absorbing', 'participant_substitution',
    'participant_attachment_pending', 'participant_activation_pending',
    'participant_reconnect_in_progress', 'participant_runtime_not_materialized',
    'participant_reconnecting',
))


def participant_host_retry_ms(attempts: int) -> int:
    """internal.ts participantHostRetryInMs, attempts counts refusals already seen."""
    return min(PARTICIPANT_HOST_FIRST_RETRY_MS * 2 ** min(max(attempts - 1, 0), 8),
               PARTICIPANT_HOST_RETRY_CAP_MS)


def steer_retry_ms(attempts: int) -> int:
    """drive/landing.ts nextDeliveryBackoffMs."""
    return min(STEER_RETRY_BASE_MS * 2 ** min(max(attempts - 1, 0), 8), STEER_RETRY_MAX_MS)


def failure_notice_retry_ms(attempts: int) -> int:
    """terminal/failure-notices.ts: first retry immediate, later refusals double."""
    return 0 if attempts <= 1 else min(
        FAILURE_NOTICE_BACKOFF_BASE_MS * 2 ** min(attempts - 2, 16), FAILURE_NOTICE_BACKOFF_MAX_MS)
