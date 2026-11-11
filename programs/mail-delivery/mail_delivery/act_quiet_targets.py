"""Quiet periodic targets (T-11680); translation of policy/wake/quiet-targets.ts.

A local-state target whose last periodic drive ended empty is skipped while
its fingerprint is unchanged. The fingerprint is deliberately blind to
timestamps. Event-driven wakes never consult this.
"""
import json
from .act_internal import PERIODIC_QUIET_BACKSTOP_MS


def _js(value):
    return '' if value is None else str(value)


def periodic_target_fingerprint(server, target_session_ref, seated):
    """The local state a periodic drive of `target_session_ref` depends on."""
    intents = sorted('|'.join([_js(intent.envelope_id), _js(intent.runtime_id), _js(intent.submission_id),
                               _js(intent.uncertain_cause), _js(intent.last_evidence_kind),
                               _js(intent.cleanup_outcome)])
                     for intent in server.store.mail_delivery.list_open_intents(target_session_ref))
    notices = sorted(notice.envelope_id
                     for notice in server.store.mail_delivery.list_undelivered_failure_notices(target_session_ref))
    return json.dumps(dict(seated=target_session_ref in seated, intents=intents, notices=notices),
                      separators=(',', ':'), ensure_ascii=False)


def select_changed_periodic_targets(server, candidates, seated, now_ms=None):
    if now_ms is None:
        now_ms = server.now_ms()
    for target_session_ref in list(server.mail_kicker_quiet_targets.keys()):
        if target_session_ref not in candidates:
            server.mail_kicker_quiet_targets.pop(target_session_ref, None)
    selected = []
    for target_session_ref in candidates:
        fingerprint = periodic_target_fingerprint(server, target_session_ref, seated)
        quiet = server.mail_kicker_quiet_targets.get(target_session_ref)
        if (quiet is not None and quiet['confirmed'] is True and
                quiet['fingerprint'] == fingerprint and
                now_ms - quiet['quietSinceMs'] < PERIODIC_QUIET_BACKSTOP_MS and
                not failure_notice_backoff_due(server, target_session_ref, now_ms)):
            continue
        server.mail_kicker_quiet_targets[target_session_ref] = dict(
            fingerprint=fingerprint, quietSinceMs=now_ms, confirmed=False)
        selected.append(target_session_ref)
    return selected


def record_periodic_drive(server, target_session_ref, outcome):
    """Confirm a periodic drive that found nothing; anything else is not quiet."""
    quiet = server.mail_kicker_quiet_targets.get(target_session_ref)
    if quiet is None:
        return
    if outcome is not None and outcome.get('outcome') == 'empty':
        quiet['confirmed'] = True
    else:
        server.mail_kicker_quiet_targets.pop(target_session_ref, None)


def failure_notice_backoff_due(server, target_session_ref, now_ms):
    backoff = server.mail_kicker_failure_notice_backoff.get(target_session_ref)
    return (backoff is not None and not backoff['exhausted'] and
            backoff.get('parkedRuntimeId') is None and backoff['nextAtMs'] <= now_ms)
