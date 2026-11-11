"""T-08576 D2: app sessions are not wrkq mail targets
(policy/__tests__/t08576-app-scope-kicker-exclusion.test.ts).

Local reconciliation/disposal work stays real; no app:* target may cross the
wrkq ledger boundary.
"""
import asyncio
import unittest

from mail_delivery.act_controller import observe_mail_drive_lifecycle_event
from mail_delivery.act_js import iso_from_ms
from mail_delivery.act_target_driver import drive_mail_target_once
from .act_kicker_fake import HOST_SESSION_ID, RUNTIME_ID, SCOPE_REF, TARGET_REF, Harness

APP_SCOPE = 'app:t08576'
APP_LANE = 'assistant'
APP_TARGET = f'{APP_SCOPE}/lane:{APP_LANE}'
APP_HOST_SESSION = 'hsid-t08576-app-kicker'
APP_RUNTIME = 'rt-t08576-app-kicker'


class RecordingLedger:
    def __init__(self, ledger):
        self.ledger = ledger
        self.calls = []

    def __getattr__(self, name):
        value = getattr(self.ledger, name)
        if not callable(value):
            return value

        def call(*args):
            self.calls.append(dict(method=name, args=args))
            return value(*args)
        return call


class AppScopeExclusionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()

    async def asyncTearDown(self):
        await self.h.close()

    def install_recording_ledger(self):
        recording = RecordingLedger(self.h.context.ledger)
        self.h.context.ledger = recording
        return recording.calls

    @staticmethod
    def pending_view_scopes(calls):
        return [(call['args'][0] or {}).get('scopes', []) for call in calls if call['method'] == 'pending_view']

    def insert_app_runtime(self):
        now = iso_from_ms(self.h.now_ms())
        self.h.db.insert_session(dict(hostSessionId=APP_HOST_SESSION, scopeRef=APP_SCOPE, laneRef=APP_LANE,
                                      generation=1, status='active', createdAt=now, updatedAt=now))
        self.h.db.insert_runtime(dict(runtimeId=APP_RUNTIME, hostSessionId=APP_HOST_SESSION, scopeRef=APP_SCOPE,
                                      laneRef=APP_LANE, generation=1, transport='tmux', harness='claude-code',
                                      provider='anthropic', status='busy', supportsInflightInput=True,
                                      createdAt=now, updatedAt=now))
        return self.h.db.sessions[APP_HOST_SESSION]

    def lifecycle_event(self, scope_ref, lane_ref, host_session_id, runtime_id, event_kind, hrc_seq):
        return dict(hrcSeq=hrc_seq, streamSeq=hrc_seq, ts=iso_from_ms(self.h.now_ms()), hostSessionId=host_session_id,
                    scopeRef=scope_ref, laneRef=lane_ref, generation=1, runtimeId=runtime_id,
                    category='runtime' if event_kind.startswith('runtime.') else 'turn', eventKind=event_kind,
                    replayed=False, payload={})

    async def wait_for(self, label, predicate):
        for _ in range(200):
            if predicate():
                return
            await asyncio.sleep(0.001)
        raise AssertionError(f'timed out waiting for {label}')

    def seed_open_intent(self, target, runtime_id, suffix):
        envelope = self.h.ledger.say()
        opened = self.h.store.mail_delivery.open_intent(envelope_id=envelope['id'], target_session_ref=target,
                                                        door='steer', form='full', presentation_id=f'present-{suffix}',
                                                        runtime_id=runtime_id, submitted_hrc_seq=1)
        if opened is None:
            raise AssertionError('failed to seed kicker intent')
        return envelope['id']

    def seed_landed_presentation(self, target, runtime_id, suffix):
        envelope = self.h.ledger.say()
        envelope['state'] = 'presented'
        envelope['presentedTo'] = [dict(memberRef=target, runtimeId=runtime_id, driveAttemptId=f'present-{suffix}',
                                        presentedAt=iso_from_ms(self.h.now_ms()))]
        self.h.store.mail_delivery.record_presentation(
            envelope_id=envelope['id'], runtime_id=runtime_id, target_session_ref=target, generation=1,
            presentation_id=f'present-{suffix}', delivery_outcome='steered', landing_hrc_seq=10)
        if not self.h.store.mail_delivery.mark_receipt_committed(envelope['id'], runtime_id):
            raise AssertionError('failed to commit kicker presentation receipt')
        return envelope['id']

    def install_deterministic_wake(self):
        operations = []
        context = self.h.context

        def wake(target, reason):
            operations.append(asyncio.ensure_future(drive_mail_target_once(context, target, reason)))
        context.wake = wake
        return operations

    async def observe_runtime_terminal(self, scope_ref, lane_ref, host_session_id, runtime_id, target, suffix):
        envelope_id = self.seed_open_intent(target, runtime_id, suffix)
        self.h.db.update_runtime(runtime_id, status='terminated')
        observe_mail_drive_lifecycle_event(self.h.context, self.lifecycle_event(
            scope_ref, lane_ref, host_session_id, runtime_id, 'runtime.terminated', 20))
        await self.wait_for(f'{suffix} intent reconciliation', lambda: (
            self.h.store.mail_delivery.get_intent(envelope_id).uncertain_cause == 'runtime_terminated_before_landing'))
        await asyncio.sleep(0)
        # The TypeScript reads its calls after one microtask; let this lapse task finish its read.
        tasks = list(self.h.context.tasks)
        if tasks:
            await asyncio.wait(tasks)
        return envelope_id

    async def observe_turn_completed(self, scope_ref, lane_ref, host_session_id, runtime_id, target, suffix):
        envelope_id = self.seed_landed_presentation(target, runtime_id, suffix)
        wake_operations = self.install_deterministic_wake()
        observe_mail_drive_lifecycle_event(self.h.context, self.lifecycle_event(
            scope_ref, lane_ref, host_session_id, runtime_id, 'turn.completed', 20))
        pending = list(self.h.context.mail_kicker_disposals_pending)
        if pending:
            await asyncio.wait(pending)
        if wake_operations:
            await asyncio.wait(wake_operations)
        return envelope_id, wake_operations

    async def test_rk1_reconciles_an_app_runtime_terminal_locally_without_reading_wrkq(self):
        self.insert_app_runtime()
        calls = self.install_recording_ledger()
        envelope_id = await self.observe_runtime_terminal(APP_SCOPE, APP_LANE, APP_HOST_SESSION, APP_RUNTIME,
                                                          APP_TARGET, 't08576-rk1-app')
        self.assertEqual(self.pending_view_scopes(calls), [])
        self.assertEqual(self.h.store.mail_delivery.get_intent(envelope_id).uncertain_cause,
                         'runtime_terminated_before_landing')

    async def test_rk2_disposes_an_app_turn_locally_without_waking_a_wrkq_read(self):
        self.insert_app_runtime()
        calls = self.install_recording_ledger()
        envelope_id, wake_operations = await self.observe_turn_completed(
            APP_SCOPE, APP_LANE, APP_HOST_SESSION, APP_RUNTIME, APP_TARGET, 't08576-rk2-app')
        self.assertEqual(self.pending_view_scopes(calls), [])
        self.assertEqual(len(wake_operations), 0)
        self.assertIsNotNone(self.h.store.mail_delivery.get_presentation(envelope_id, APP_RUNTIME).reminder_armed_at)
        self.assertEqual([call['method'] for call in calls], ['envelope_show'])

    async def test_control_keeps_the_agent_runtime_terminal_wrkq_lapse_read(self):
        calls = self.install_recording_ledger()
        envelope_id = await self.observe_runtime_terminal(SCOPE_REF, 'main', HOST_SESSION_ID, RUNTIME_ID, TARGET_REF,
                                                          't08576-rk1-agent')
        self.assertEqual(self.pending_view_scopes(calls), [[TARGET_REF]])
        self.assertEqual(self.h.store.mail_delivery.get_intent(envelope_id).uncertain_cause,
                         'runtime_terminated_before_landing')

    async def test_control_keeps_the_agent_turn_terminal_disposal_and_wrkq_wake_read(self):
        calls = self.install_recording_ledger()
        envelope_id, wake_operations = await self.observe_turn_completed(
            SCOPE_REF, 'main', HOST_SESSION_ID, RUNTIME_ID, TARGET_REF, 't08576-rk2-agent')
        self.assertEqual(self.pending_view_scopes(calls), [[TARGET_REF]])
        self.assertEqual(len(wake_operations), 1)
        self.assertIsNotNone(self.h.store.mail_delivery.get_presentation(envelope_id, RUNTIME_ID).reminder_armed_at)


if __name__ == '__main__':
    unittest.main()
