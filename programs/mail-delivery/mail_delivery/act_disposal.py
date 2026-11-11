"""D3 — disposal keyed by RUNTIME and ledger SEQUENCE, never by run or turn;
translation of policy/terminal/disposal.ts.

Every decision is written to the presentation row as it is MADE, so a stop or
a crash mid-loop leaves the reconcile a candidate rather than silence.
"""
import asyncio
from .act_js import iso_from_ms as _iso
from .act_internal import REMINDER_HOLD_MS, error_text
from .act_types import newest_presentation_receipt




def dispose_runtime_obligations(server, input):
    """Dispose what one runtime was holding when a turn on it ended.

    Registered on `mail_kicker_disposals_pending` so `stop()` drains it.
    """
    candidates = server.store.mail_delivery.list_undisposed_for_runtime(input['runtimeId'])
    if len(candidates) == 0:
        return
    outcomes = {}

    async def disposal_body():
        reminders_armed = 0
        for presentation in candidates:
            try:
                row = await server.ledger.envelope_show({'envelope': presentation.envelope_id})
                if row['state'] != 'presented':
                    outcomes[presentation.envelope_id] = 'skipped:not_presented'
                    server.store.mail_delivery.record_disposition(
                        presentation.envelope_id, input['runtimeId'], f"skipped:not_presented:{row['state']}")
                    continue
                newest = newest_presentation_receipt(row)
                if (newest or {}).get('runtimeId') != input['runtimeId']:
                    outcomes[presentation.envelope_id] = 'skipped:superseded'
                    server.store.mail_delivery.record_disposition(
                        presentation.envelope_id, input['runtimeId'], 'skipped:superseded')
                    continue
                reminder_seq = presentation.reminder_landing_hrc_seq
                if reminder_seq is not None and reminder_seq < input['terminalHrcSeq']:
                    held = server.store.mail_delivery.record_disposition(
                        presentation.envelope_id, input['runtimeId'], 'held:awaiting_operator')
                    outcomes[presentation.envelope_id] = 'held:awaiting_operator'
                    if held:
                        server.log('WARN', 'wrkq.kicker.obligation_held', dict(
                            envelope=presentation.envelope_id, targetSessionRef=input['targetSessionRef'],
                            runtimeId=input['runtimeId'], presentationId=presentation.presentation_id,
                            terminalEventKind=input['terminalEventKind'], terminalHrcSeq=input['terminalHrcSeq'],
                            holdReason='reminder_landed_before_later_terminal'))
                    continue
                if reminder_seq is not None or presentation.reminder_armed_at is not None:
                    outcomes[presentation.envelope_id] = 'skipped:reminder_pending'
                    continue
                if presentation.landing_hrc_seq >= input['terminalHrcSeq']:
                    outcomes[presentation.envelope_id] = 'skipped:awaiting_turn'
                    continue
                armed = server.store.mail_delivery.arm_reminder(
                    envelope_id=presentation.envelope_id, runtime_id=input['runtimeId'],
                    turn_ended_at=input['turnEndedAt'], remind_at=_iso(server.now_ms() + REMINDER_HOLD_MS))
                if not armed:
                    outcomes[presentation.envelope_id] = 'skipped:reminder_pending'
                    continue
                reminders_armed += 1
                outcomes[presentation.envelope_id] = 'reminded'
                server.log('INFO', 'wrkq.kicker.reminder_armed', dict(
                    targetSessionRef=input['targetSessionRef'], envelope=presentation.envelope_id,
                    runtimeId=input['runtimeId'], terminalEventKind=input['terminalEventKind']))
            except Exception as error:
                outcomes[presentation.envelope_id] = 'skipped:error'
                server.log('WARN', 'wrkq.kicker.dispose_obligation_failed', dict(
                    targetSessionRef=input['targetSessionRef'], envelope=presentation.envelope_id,
                    runtimeId=input['runtimeId'], error=error_text(error)))
        server.log('INFO', 'wrkq.kicker.runtime_disposal', dict(
            targetSessionRef=input['targetSessionRef'], runtimeId=input['runtimeId'],
            terminalEventKind=input['terminalEventKind'], terminalHrcSeq=input['terminalHrcSeq'],
            examined=len(candidates), remindersArmed=reminders_armed, outcomes=outcomes))
        if reminders_armed > 0:
            def wake():
                if not server.stopping:
                    server.wake(input['targetSessionRef'], 'turn_completion')
            asyncio.get_running_loop().call_later(REMINDER_HOLD_MS / 1000, wake)

    disposal = asyncio.get_running_loop().create_task(disposal_body(), eager_start=True)
    server.mail_kicker_disposals_pending.add(disposal)
    disposal.add_done_callback(server.mail_kicker_disposals_pending.discard)
