"""rev 5.1 D3 — a runtime that terminated holding an obligation fails it;
translation of policy/terminal/runtime-lapse.ts.

Returns whether the observation COMPLETED, so a caller can memoize a runtime
as swept without memoizing a ledger outage as an answer.
"""
from .act_js import iso_from_ms as _iso
from .act_contracts import WrkqLedgerUnavailableError
from .act_hrc_facts import hrc_facts
from .act_internal import LAPSE_SWEEP_LOOKBACK_MS, PERIODIC_QUIET_BACKSTOP_MS, error_text
from .act_runtime_status import is_runtime_terminal
from .act_types import newest_presentation_receipt




async def fail_lapsed_obligations(server, target_session_ref, runtime_ids):
    try:
        view = await server.ledger.pending_view(dict(scopes=[target_session_ref], includeFyi=True))
    except Exception as error:
        server.log('WARN' if isinstance(error, WrkqLedgerUnavailableError) else 'ERROR',
                   'wrkq.kicker.lapse_pending_view_failed',
                   dict(targetSessionRef=target_session_ref, error=error_text(error)))
        return False
    complete = True
    for envelope in view['items']:
        if envelope['state'] != 'presented':
            continue
        receipt = newest_presentation_receipt(envelope)
        runtime = None if receipt is None else receipt.get('runtimeId')
        if runtime is None or runtime not in runtime_ids:
            continue
        presentation = server.store.mail_delivery.get_presentation(envelope['id'], runtime)
        if presentation is not None and presentation.disposition == 'held:awaiting_operator':
            continue
        try:
            await server.fail_envelope_with_audit(dict(
                envelope=envelope['id'], reason='runtime_terminated', runtime=runtime,
                targetSessionRef=target_session_ref,
                **({} if receipt is None or receipt.get('driveAttemptId') is None
                   else {'presentationId': receipt['driveAttemptId']}),
                callSite='lapsed_obligations'))
            server.store.mail_delivery.record_disposition(envelope['id'], runtime, 'failed:runtime_terminated')
        except Exception as error:
            server.log('WARN', 'wrkq.kicker.lapse_failed', dict(
                targetSessionRef=target_session_ref, envelope=envelope['id'], runtimeId=runtime,
                error=error_text(error)))
            complete = False
    return complete


async def sweep_lapsed_obligations(server):
    """The D3 backstop: every locally-known runtime that has since gone terminal."""
    now_ms = server.now_ms()
    since = _iso(now_ms - LAPSE_SWEEP_LOOKBACK_MS)
    by_target = {}
    bound = server.store.mail_delivery.list_runtime_bound_targets(since)
    bound_runtimes = set(row.runtime_id for row in bound)
    for runtime_id in list(server.mail_kicker_live_runtime_seen_at.keys()):
        if runtime_id not in bound_runtimes:
            server.mail_kicker_live_runtime_seen_at.pop(runtime_id, None)
    facts = hrc_facts(server)
    keyed = facts.serving
    for runtime_id in list(facts.live_runtime_memo.keys()):
        if runtime_id not in bound_runtimes:
            facts.live_runtime_memo.pop(runtime_id, None)
    for row in bound:
        if row.runtime_id in server.mail_kicker_lapsed_runtimes:
            continue
        version = facts.runtime_version(row.runtime_id)
        if keyed:
            if facts.live_runtime_memo.get(row.runtime_id) == version:
                continue
        else:
            seen_live_at = server.mail_kicker_live_runtime_seen_at.get(row.runtime_id)
            if seen_live_at is not None and now_ms - seen_live_at < PERIODIC_QUIET_BACKSTOP_MS:
                continue
        runtime = await server.port.runtime(row.runtime_id)
        if runtime is not None and not is_runtime_terminal(runtime['status']):
            server.mail_kicker_live_runtime_seen_at[row.runtime_id] = now_ms
            facts.live_runtime_memo[row.runtime_id] = version
            continue
        server.mail_kicker_live_runtime_seen_at.pop(row.runtime_id, None)
        facts.live_runtime_memo.pop(row.runtime_id, None)
        runtimes = by_target.get(row.target_session_ref, set())
        runtimes.add(row.runtime_id)
        by_target[row.target_session_ref] = runtimes
    for target_session_ref, runtime_ids in by_target.items():
        if await fail_lapsed_obligations(server, target_session_ref, runtime_ids):
            for runtime_id in runtime_ids:
                server.mail_kicker_lapsed_runtimes.add(runtime_id)
