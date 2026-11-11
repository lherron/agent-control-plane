"""Constants and helpers translated from policy/internal.ts."""
import re
from .store import _JS_WHITESPACE

RUNTIME_TERMINAL_EVENTS = set([
  'runtime.terminated',
  'runtime.crashed',
  'runtime.dead',
  'runtime.stale',
])

MAIL_DRIVE_TERMINAL_EVENTS = set([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.zombied',
  'turn.reaped',
])

REMINDER_HOLD_MS = 60_000

STEER_RETRY_BASE_MS = 2_000

STEER_RETRY_MAX_MS = 30_000

STEER_HOLD_MAX_MS = 10 * 60_000

KICKER_MAX_NON_LANDING_STRIKES = 3

KICKER_SUBMISSION_TTL_MS = 30 * 60_000

LEDGER_TAIL_PAGE_LIMIT = 500

LEDGER_SWEEP_SCOPE_BATCH = 100

LEDGER_SWEEP_TICKS = 300

REMINDER_CHECK_TICKS = 30

PERIODIC_QUIET_BACKSTOP_MS = 10 * 60_000

MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES = 4

BIRTH_SWEEP_BACKOFF_BASE_MS = 60_000

PARTICIPANT_HOST_FIRST_RETRY_MS = 10_000

PARTICIPANT_HOST_RETRY_CAP_MS = 60_000

PARTICIPANT_HOST_GIVE_UP_MS = 10 * 60_000

BIRTH_SWEEP_NOT_HOSTED_BASE_MS = 15 * 60_000

FAILURE_NOTICE_BACKOFF_BASE_MS = 30_000

FAILURE_NOTICE_BACKOFF_MAX_MS = 60 * 60_000

FAILURE_NOTICE_MAX_ATTEMPTS = 8

BIRTH_SWEEP_MAX_REFUSALS = 5

LAPSE_SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000

DISPOSAL_DRAIN_DEADLINE_MS = 2_000

RECONCILE_RUNTIME_READ_DEADLINE_MS = 2_000

STALLED_DELIVERY_THRESHOLD_MS = 5 * 60_000

STEER_WRITE_RECONCILE_GRACE_MS = 60_000

def participant_host_retry_in_ms(attempts):
    return min(PARTICIPANT_HOST_FIRST_RETRY_MS * 2 ** (attempts - 1), PARTICIPANT_HOST_RETRY_CAP_MS)


def error_text(error):
    return str(error)


def is_record(value):
    return isinstance(value, dict)


def parse_session_ref(session_ref):
    normalized = session_ref.strip(_JS_WHITESPACE)
    parts = normalized.split('/')
    if len(parts) != 2 or not parts[1].startswith('lane:'):
        raise ValueError('sessionRef must use "<scopeRef>/lane:<laneRef>" format')
    scope_ref = parts[0].strip(_JS_WHITESPACE)
    lane_ref = parts[1][len('lane:'):].strip(_JS_WHITESPACE)
    if not scope_ref or not lane_ref:
        raise ValueError('sessionRef must include scopeRef and laneRef')
    return {'scopeRef': scope_ref, 'laneRef': lane_ref}


def format_session_ref(scope_ref, lane_ref):
    return f"{scope_ref}/lane:{'main' if lane_ref == 'default' else lane_ref}"


def normalize_target_session_ref(session_ref):
    parts = parse_session_ref(session_ref)
    scope = parts['scopeRef']
    if not re.fullmatch(r'agent:[A-Za-z0-9._-]{1,64}(?::project:[A-Za-z0-9._-]{1,64}(?:(?::task:[A-Za-z0-9._-]{1,64})?(?::role:[A-Za-z0-9._-]{1,64})?)?)?', scope):
        raise ValueError('invalid scopeRef')
    return format_session_ref(scope, parts['laneRef'])


def is_run_active(run):
    return run['status'] in ('accepted', 'started', 'running')


def is_runtime_unavailable_status(status):
    return status in ('terminated', 'crashed', 'dead', 'stale', 'stopped', 'failed', 'disposed', 'exited', 'detached')
