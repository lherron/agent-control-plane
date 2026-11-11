"""The 300-second recovery backstop behind insert/lifecycle wakes and the
deferral deadline timer; translation of policy/wake/sweep.ts.
"""
import asyncio
from .act_birth_retry import unborn_birth_wake_candidates
from .act_cold_start import chunk, collect_pending_targets, homed_target_session_refs
from .act_contracts import WrkqLedgerUnavailableError
from .act_hrc_facts import hrc_facts
from .act_internal import LEDGER_SWEEP_SCOPE_BATCH, error_text
from .act_js import OrderedSet, iso_from_ms
from .act_quiet_targets import select_changed_periodic_targets
from .act_reconcile import reconcile_open_intents
from .act_runtime_lapse import sweep_lapsed_obligations
from .act_stranded import report_boot_reconcile_once, report_stalled_deliveries


def run_mail_kicker_sweep(server):
    """Returns an awaitable for the one in-flight sweep."""
    if not server.enabled or server.stopping:
        return _resolved()
    if server.mail_kicker_sweep_in_flight is not None:
        return asyncio.shield(server.mail_kicker_sweep_in_flight)

    async def sweep_body():
        try:
            await reconcile_open_intents(server, dict(reason='periodic'))
        except Exception as error:
            server.log('WARN', 'wrkq.kicker.intent_reconcile_failed', dict(error=error_text(error)))
        await report_boot_reconcile_once(server)
        try:
            await report_stalled_deliveries(server)
        except Exception as error:
            server.log('WARN', 'wrkq.kicker.stalled_delivery_check_failed', dict(error=error_text(error)))
        await sweep_lapsed_obligations(server)
        try:
            await server.ledger.pending_view(dict(scopes=[]))
        except Exception as error:
            server.log('WARN', 'wrkq.kicker.sweep_repend_failed', dict(error=error_text(error)))
        now = iso_from_ms(server.now_ms())
        outstanding = OrderedSet(server.store.mail_delivery.list_due_reminder_targets(now))
        seated = await hrc_facts(server).live_session_refs()
        unborn = await unborn_birth_wake_candidates(server, seated)
        homed = await homed_target_session_refs(server)
        recipients = list(OrderedSet([*seated, *unborn, *homed]))
        for batch in chunk(recipients, LEDGER_SWEEP_SCOPE_BATCH):
            try:
                view = await server.ledger.pending_view(dict(scopes=batch, includeFyi=True))
                if view['repended'] > 0:
                    server.log('INFO', 'wrkq.kicker.deferrals_repended', dict(repended=view['repended']))
                collect_pending_targets(view['items'], outstanding)
            except Exception as error:
                server.log('WARN' if isinstance(error, WrkqLedgerUnavailableError) else 'ERROR',
                           'wrkq.kicker.sweep_pending_view_failed', dict(scopes=len(batch), error=error_text(error)))
                break
        local = OrderedSet()
        for target in server.store.mail_delivery.list_intent_targets():
            local.add(target)
        for target in server.store.mail_delivery.list_failure_notice_targets():
            local.add(target)
        for target in outstanding:
            local.discard(target)
        targets = OrderedSet(outstanding)
        for target in select_changed_periodic_targets(server, local, set(seated)):
            targets.add(target)
        for target_session_ref in targets:
            server.mail_kicker_pending_targets[target_session_ref] = 'periodic'
        for target_session_ref in targets:
            server.spawn(_drain(server, target_session_ref))
        server.log('INFO', 'wrkq.kicker.sweep_complete', dict(targets=len(targets)))

    sweep = asyncio.get_running_loop().create_task(sweep_body(), eager_start=True)

    def finished(_task):
        if server.mail_kicker_sweep_in_flight is sweep:
            server.mail_kicker_sweep_in_flight = None
    sweep.add_done_callback(finished)
    server.mail_kicker_sweep_in_flight = sweep
    return asyncio.shield(sweep)


async def _drain(server, target_session_ref):
    try:
        await server.drain_target(target_session_ref)
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.sweep_target_drive_failed', dict(
            targetSessionRef=target_session_ref, error=error_text(error)))


async def _resolved():
    return None
