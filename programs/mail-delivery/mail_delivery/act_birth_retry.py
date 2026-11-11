"""The VIRGIN BIRTHS this node owes, as sweep candidates (T-07661), the D7
refusal bound and the participant-host retry clock; translation of
policy/wake/birth-retry.ts.
"""
from .act_authority import kicker_scope_ref_for
from .act_hrc_facts import hrc_facts
from .act_internal import (BIRTH_SWEEP_BACKOFF_BASE_MS, BIRTH_SWEEP_MAX_REFUSALS, BIRTH_SWEEP_NOT_HOSTED_BASE_MS,
                           error_text, participant_host_retry_in_ms)
from .act_js import INFINITY, OrderedSet
from .act_scope import target_session_ref_for_ledger_scope


async def unborn_birth_wake_candidates(server, seated):
    seated_set = set(seated)
    candidates = OrderedSet()

    for target_session_ref in await designated_unborn_targets(server):
        if target_session_ref not in seated_set:
            candidates.add(target_session_ref)
    for target_session_ref in refused_birth_targets(server):
        if target_session_ref not in seated_set:
            candidates.add(target_session_ref)

    for target_session_ref in list(server.mail_kicker_birth_sweep_backoff.keys()):
        if target_session_ref not in candidates:
            server.mail_kicker_birth_sweep_backoff.pop(target_session_ref, None)

    now = server.now_ms()
    return [target_session_ref for target_session_ref in candidates
            if (server.mail_kicker_birth_sweep_backoff.get(target_session_ref) or {}).get('nextAtMs', 0) <= now]


async def designated_unborn_targets(server):
    """Live designations naming this node whose scope the registry has never bound."""
    try:
        designations = (await hrc_facts(server).unborn_designations())['designations']
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.unborn_designations_failed', dict(
            nodeId=server.node_id, error=error_text(error)))
        return []
    targets = []
    for designation in designations:
        session_ref = target_session_ref_for_ledger_scope(designation['scopeRef'])
        if session_ref is not None:
            targets.append(session_ref)
    return targets


def refused_birth_targets(server):
    """Scopes this node refused a birth for, from its own birth-refusal rows."""
    targets = []
    for target_session_ref in server.store.mail_delivery.list_refused_birth_targets():
        scope_ref = kicker_scope_ref_for(target_session_ref)
        if scope_ref is None:
            continue
        if scope_ref in server.mail_kicker_birth_deferred_announced:
            continue
        targets.append(target_session_ref)
    return targets


async def charge_birth_sweep_refusal(server, target_session_ref, refusal=None):
    """Charge one retry after a periodic drive ACTUALLY attempted a birth, and
    give up on the fifth (rev 5.1 D7)."""
    refusal = refusal or {}
    now = server.now_ms()
    base_ms = BIRTH_SWEEP_NOT_HOSTED_BASE_MS if refusal.get('notPlaceableHere') is True else BIRTH_SWEEP_BACKOFF_BASE_MS
    prior = server.mail_kicker_birth_sweep_backoff.get(target_session_ref)
    attempts = (0 if prior is not None and prior.get('participantHost') is True
                else (0 if prior is None else prior['attempts'])) + 1
    if attempts >= BIRTH_SWEEP_MAX_REFUSALS:
        try:
            birth_refusal = server.store.mail_delivery.get_birth_refusal(target_session_ref)
            last_reason = None if birth_refusal is None else birth_refusal.last_reason
            terminal = await server.fail_undeliverable_mail(target_session_ref, dict(
                refusals=attempts, callSite='birth_refusals_exhausted',
                detail=(f'HRC refused the birth {attempts} times' if last_reason is None
                        else f'HRC refused the birth {attempts} times; last: {last_reason}')))
            if terminal is not None:
                server.mail_kicker_birth_sweep_backoff.pop(target_session_ref, None)
            else:
                server.mail_kicker_birth_sweep_backoff[target_session_ref] = dict(
                    attempts=BIRTH_SWEEP_MAX_REFUSALS - 1, nextAtMs=now + base_ms * 2 ** (attempts - 1))
        except Exception as error:
            server.mail_kicker_birth_sweep_backoff[target_session_ref] = dict(
                attempts=BIRTH_SWEEP_MAX_REFUSALS - 1, nextAtMs=now + base_ms * 2 ** (attempts - 1))
            server.log('WARN', 'wrkq.kicker.undeliverable_failed', dict(
                targetSessionRef=target_session_ref, error=error_text(error)))
        return
    server.mail_kicker_birth_sweep_backoff[target_session_ref] = dict(
        attempts=attempts, nextAtMs=now + base_ms * 2 ** (attempts - 1))
    server.log('INFO', 'wrkq.kicker.unborn_birth_retry', dict(
        targetSessionRef=target_session_ref, attempt=attempts, nextAttemptInMs=base_ms * 2 ** (attempts - 1)))


async def fail_undeliverable_mail(server, target_session_ref, failure):
    """rev 5.1 D7 — this node cannot seat the addressee, and has stopped trying.

    Returns how many envelopes it failed once the bound is settled, or None
    when it could not settle it and the refusal must stay open."""
    refusals = failure['refusals']
    scope_ref = kicker_scope_ref_for(target_session_ref)
    if scope_ref is None:
        server.log('WARN', 'wrkq.kicker.undeliverable_home_unresolved', dict(
            targetSessionRef=target_session_ref, reason='target session ref has no parseable scope'))
        return None
    try:
        home = await server.port.locate(scope_ref)
        if home is not None and home.get('homeNodeId') != server.node_id:
            home_node_id = home.get('homeNodeId')
            server.foreign_home_memo[scope_ref] = dict(homeNodeId=home_node_id, source='registry')
            resolved_birth = server.store.mail_delivery.resolve_birth_refusal(
                target_session_ref, f'{scope_ref} is homed on {home_node_id}; this node has no authority to fail its mail')
            server.log('INFO', 'wrkq.kicker.undeliverable_skipped_foreign_home', dict(
                targetSessionRef=target_session_ref, scopeRef=scope_ref, homeNodeId=home_node_id,
                refusals=refusals, resolvedBirthRefusal=resolved_birth))
            return dict(failed=0)
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.undeliverable_home_consult_failed', dict(
            targetSessionRef=target_session_ref, scopeRef=scope_ref, error=error_text(error)))
        return None

    failed = 0
    view = await server.ledger.pending_view(dict(scopes=[target_session_ref]))
    for envelope in view['items']:
        if envelope['state'] != 'pending':
            continue
        if len(envelope['presentedTo']) > 0:
            continue
        server.log('WARN', f"wrkq.kicker.{failure['callSite']}", dict(
            targetSessionRef=target_session_ref, envelope=envelope['id'], refusals=refusals))
        result = await server.fail_envelope_with_audit(dict(
            envelope=envelope['id'], reason='undeliverable', detail=failure['detail'],
            targetSessionRef=target_session_ref, callSite=failure['callSite']))
        if result.get('outcome') == 'failed':
            failed += 1
    return dict(failed=failed)


def wake_due_birth_retries(server, now):
    """Wake every target whose birth retry time has passed (T-13151)."""
    for target_session_ref, backoff in list(server.mail_kicker_birth_sweep_backoff.items()):
        if backoff.get('dueWoken') is True or backoff['nextAtMs'] > now:
            continue
        backoff['dueWoken'] = True
        server.log('INFO', 'wrkq.kicker.birth_retry_due', dict(
            targetSessionRef=target_session_ref, attempts=backoff['attempts'], lateMs=now - backoff['nextAtMs']))
        server.wake(target_session_ref, 'periodic')


def next_birth_retry_at(server):
    """The earliest birth retry the ledger loop has not yet woken."""
    next = INFINITY
    for backoff in server.mail_kicker_birth_sweep_backoff.values():
        if backoff.get('dueWoken') is not True:
            next = min(next, backoff['nextAtMs'])
    return next


def schedule_participant_host_retry(server, target_session_ref, reason):
    """10 s, 20 s, 40 s, then every minute, on the birth retry clock."""
    prior = server.mail_kicker_birth_sweep_backoff.get(target_session_ref)
    attempts = (prior['attempts'] if prior is not None and prior.get('participantHost') is True else 0) + 1
    next_attempt_in_ms = participant_host_retry_in_ms(attempts)
    server.mail_kicker_birth_sweep_backoff[target_session_ref] = dict(
        attempts=attempts, nextAtMs=server.now_ms() + next_attempt_in_ms, participantHost=True)
    server.log('INFO', 'wrkq.kicker.participant_host_retry', dict(
        targetSessionRef=target_session_ref, participantHostRefusal=reason, attempts=attempts,
        nextAttemptInMs=next_attempt_in_ms))
