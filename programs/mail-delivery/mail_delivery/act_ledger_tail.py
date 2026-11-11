"""Follow wrkq's event ledger for envelope lifecycle changes, from a PERSISTED
cursor; translation of policy/wake/ledger-tail.ts.
"""
import asyncio
import json
from .act_cold_start import run_mail_kicker_cold_start_catchup
from .act_contracts import WrkqLedgerUnavailableError
from .act_deferred import forget_deferred_wake, observe_deferred_wake
from .act_digest_group import digest_members
from .act_failure_notices import queue_failure_notice
from .act_hrc_facts import hrc_facts
from .act_internal import LEDGER_TAIL_PAGE_LIMIT, error_text, is_record
from .act_scope import target_session_ref_for_ledger_scope
from .act_types import obligation_summons

QUEUED_INJECTION_WITHDRAW_REASON = 'envelope_terminal_before_injection'


async def withdraw_acked_queued_injection(server, event):
    if event.get('payload') is not None:
        try:
            payload = json.loads(event['payload'])
            if is_record(payload) and payload.get('reason') == 'fyi_presented':
                return
        except (ValueError, TypeError):
            pass

    envelope_id = event.get('resourceId')
    if envelope_id is None:
        return

    intent = server.store.mail_delivery.get_intent(envelope_id)
    if intent is None:
        return
    terminal = server.store.mail_delivery.mark_terminal_envelope(envelope_id, event['eventType'])
    if terminal is None:
        terminal = intent
    if terminal.cleanup_at is not None:
        return
    if terminal.runtime_id is None or terminal.door == 'launch':
        server.store.mail_delivery.record_terminal_cleanup(envelope_id, 'not_applicable')
        server.log('INFO', 'wrkq.kicker.queued_injection_withdraw_skipped', dict(
            envelopeId=envelope_id,
            **({} if terminal.runtime_id is None else {'runtimeId': terminal.runtime_id}),
            door=terminal.door, reason=QUEUED_INJECTION_WITHDRAW_REASON, outcome='not_applicable',
            selector='envelope_fallback_diagnostic'))
        return

    live_siblings = [member for member in digest_members(server, terminal)
                     if member.envelope_id != envelope_id and member.terminal_envelope_at is None]
    if len(live_siblings) > 0:
        server.store.mail_delivery.record_terminal_cleanup(envelope_id, 'digest_sibling_live')
        server.log('INFO', 'wrkq.kicker.queued_injection_withdraw_skipped', dict(
            envelopeId=envelope_id, runtimeId=terminal.runtime_id, door=terminal.door,
            reason=QUEUED_INJECTION_WITHDRAW_REASON, outcome='digest_sibling_live',
            liveSiblings=[member.envelope_id for member in live_siblings]))
        return

    try:
        withdrawal = await server.port.withdraw(
            dict(runtimeId=terminal.runtime_id, envelopeId=envelope_id, reason=QUEUED_INJECTION_WITHDRAW_REASON)
            if terminal.submission_id is None else
            dict(runtimeId=terminal.runtime_id, submissionId=terminal.submission_id,
                 reason=QUEUED_INJECTION_WITHDRAW_REASON))
    except Exception as error:
        server.store.mail_delivery.record_terminal_cleanup(envelope_id, 'unsupported_or_error')
        server.log('WARN', 'wrkq.kicker.queued_injection_withdraw_failed', dict(
            envelopeId=envelope_id, runtimeId=terminal.runtime_id,
            **({} if terminal.submission_id is None else {'submissionId': terminal.submission_id}),
            reason=QUEUED_INJECTION_WITHDRAW_REASON, error=error_text(error)))
        return
    if not withdrawal['ok']:
        server.store.mail_delivery.record_terminal_cleanup(envelope_id, 'unsupported_or_error')
        server.log('WARN', 'wrkq.kicker.queued_injection_withdraw_failed', dict(
            envelopeId=envelope_id, runtimeId=terminal.runtime_id,
            **({} if terminal.submission_id is None else {'submissionId': terminal.submission_id}),
            reason=QUEUED_INJECTION_WITHDRAW_REASON, error=withdrawal['error']['message']))
        return

    response = withdrawal['response']
    if response['outcome'] == 'withdrawn':
        server.store.mail_delivery.record_terminal_cleanup(envelope_id, 'withdrawn')
        server.log('INFO', 'wrkq.kicker.queued_injection_withdrawn', dict(
            envelopeId=envelope_id, runtimeId=terminal.runtime_id,
            **({} if terminal.submission_id is None else {'submissionId': terminal.submission_id}),
            door=terminal.door, reason=QUEUED_INJECTION_WITHDRAW_REASON))
        return

    server.store.mail_delivery.record_terminal_cleanup(envelope_id, response['outcome'])
    server.log('INFO', 'wrkq.kicker.queued_injection_withdraw_skipped', dict(
        envelopeId=envelope_id, runtimeId=terminal.runtime_id, door=terminal.door,
        reason=QUEUED_INJECTION_WITHDRAW_REASON, outcome=response['outcome'],
        **({'state': response['state']} if 'state' in response else {})))


async def run_wrkq_ledger_tail(server):
    if not server.enabled or server.stopping:
        return
    if server.wrkq_ledger_tail_in_flight is not None:
        return await asyncio.shield(server.wrkq_ledger_tail_in_flight)

    async def tail_body():
        try:
            cursor = server.store.wrkq_ledger_cursors.get()
            if cursor is None:
                cursor = server.store.wrkq_ledger_cursors.advance(await resolve_tail_start_cursor(server))
                server.mail_kicker_cold_start_catchup_pending = True
                server.log('INFO', 'wrkq.kicker.tail_started', dict(cursor=cursor))
            if server.mail_kicker_cold_start_catchup_pending:
                await run_mail_kicker_cold_start_catchup(server)
                server.mail_kicker_cold_start_catchup_pending = False
            while True:
                if server.stopping:
                    return
                page = await server.ledger.events_view(dict(
                    cursor=cursor,
                    eventTypes=['envelope.created', 'envelope.failed', 'envelope.acked', 'envelope.deferred',
                                'envelope.expired', 'envelope.withdrawn'],
                    limit=LEDGER_TAIL_PAGE_LIMIT))
                seated = None
                for event in page['items']:
                    if event['eventType'] == 'envelope.deferred':
                        if event.get('resourceId') is not None:
                            await observe_deferred_wake(server, event['resourceId'])
                        continue
                    if event.get('resourceId') is not None:
                        forget_deferred_wake(server, event['resourceId'])
                    if event['eventType'] == 'envelope.expired' or event['eventType'] == 'envelope.withdrawn':
                        continue
                    if event['eventType'] == 'envelope.acked':
                        await withdraw_acked_queued_injection(server, event)
                        continue
                    if event['eventType'] == 'envelope.failed':
                        await withdraw_acked_queued_injection(server, event)
                        try:
                            await queue_failure_notice(server, event)
                        except Exception as error:
                            server.log('WARN', 'wrkq.kicker.failure_notice_queue_failed', dict(
                                envelope=event.get('resourceId'), error=error_text(error)))
                        continue
                    if seated is None:
                        seated = set(await hrc_facts(server).live_session_refs())
                    target = wake_target_for_event(event, seated)
                    if target is None:
                        continue
                    server.wake(target, 'insert')
                previous = cursor
                if page['highWater'] > cursor:
                    cursor = server.store.wrkq_ledger_cursors.advance(page['highWater'])
                if len(page['items']) < LEDGER_TAIL_PAGE_LIMIT or cursor <= previous:
                    break
        except Exception as error:
            server.log('WARN' if isinstance(error, WrkqLedgerUnavailableError) else 'ERROR',
                       'wrkq.kicker.tail_failed', dict(error=error_text(error)))

    tail = asyncio.get_running_loop().create_task(tail_body(), eager_start=True)

    def finished(_task):
        if server.wrkq_ledger_tail_in_flight is tail:
            server.wrkq_ledger_tail_in_flight = None
    tail.add_done_callback(finished)  # scheduled, so it runs after the assignment below
    server.wrkq_ledger_tail_in_flight = tail
    return await asyncio.shield(tail)


async def resolve_tail_start_cursor(server):
    """"Now", resolved from row identity rather than arithmetic."""
    before_last = await server.ledger.events_view(dict(cursor=0, lastN=1))
    start = max(before_last['highWater'], 0)
    end = await server.ledger.events_view(dict(cursor=start, limit=1))
    return max(end['highWater'], start)


def wake_target_for_event(event, seated_session_refs):
    """The target an `envelope.created` wakes, or None for one that never kicks."""
    if event['eventType'] != 'envelope.created' or event.get('payload') is None:
        return None
    try:
        parsed = json.loads(event['payload'])
    except (ValueError, TypeError):
        return None
    if not is_record(parsed):
        return None
    payload = parsed
    scope_ref = payload.get('to_scope_ref')
    if not isinstance(scope_ref, str):
        return None
    target = target_session_ref_for_ledger_scope(scope_ref)
    if target is None:
        return None
    if obligation_summons(payload.get('obligation')):
        return target
    return target if target in seated_session_refs else None
