"""T-08139 D2 — broker-start failure returns a seated target to the sweep
(policy/__tests__/t08139-broker-start-birth-retry.test.ts)."""
import asyncio
import unittest

from mail_delivery.act_birth_retry import unborn_birth_wake_candidates
from mail_delivery.act_controller import observe_mail_drive_lifecycle_event
from mail_delivery.act_js import iso_from_ms
from mail_delivery.act_presentation import read_actionable_envelopes
from mail_delivery.act_reconcile import reconcile_open_intents
from mail_delivery.act_sweep import run_mail_kicker_sweep
from .act_kicker_fake import RUNTIME_ID as OLD_RUNTIME, SCOPE_REF as SCOPE, TARGET_REF as TARGET, Harness, \
    deliver_one_to, seat_in

FAILED_RUNTIME = 'rt-t08139-failed-replacement'


class BrokerStartBirthRetryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()
        self.context = self.h.context

    async def asyncTearDown(self):
        await self.h.close()

    def broker_start_failed_event(self):
        return dict(hrcSeq=81_139, streamSeq=81_139, ts=iso_from_ms(self.h.now_ms()),
                    hostSessionId=self.h.session['hostSessionId'], scopeRef=SCOPE, laneRef='main',
                    generation=self.h.session['generation'], runtimeId=FAILED_RUNTIME,
                    runId='run-t08139-failed-replacement', category='turn', eventKind='turn.failed',
                    transport='tmux', replayed=False,
                    payload=dict(code='broker_start_failed', message='thread already has an active writer',
                                 phase='broker-invocation-start'))

    async def test_a_periodic_sweep_settles_while_a_target_drive_is_blocked(self):
        envelope = self.h.ledger.say(body='landing observed after first periodic pass')
        await deliver_one_to(self.h, seat_in('turn-active'), envelope)
        drive_blocked = asyncio.get_running_loop().create_future()
        drives = 0
        target_drive = None

        async def drain_target(_target):
            nonlocal drives, target_drive
            if target_drive is None:
                async def drive():
                    nonlocal drives
                    drives += 1
                    await drive_blocked
                target_drive = asyncio.ensure_future(drive())
            await asyncio.shield(target_drive)
        self.context.drain_target = drain_target

        sweep = asyncio.ensure_future(run_mail_kicker_sweep(self.context))
        try:
            await asyncio.sleep(0.01)
            self.assertTrue(sweep.done())
            self.h.db.append_event(dict(invocationId='inv-t08094', runtimeId=OLD_RUNTIME, seq=999,
                                        time=iso_from_ms(self.h.now_ms()), type='submission.executed',
                                        payload=dict(submissionId='sub-1', turnId='turn-after-observer-race')))
            await run_mail_kicker_sweep(self.context)
            self.assertEqual(len(self.h.ledger.envelopes[envelope['id']]['presentedTo']), 1)
            self.assertEqual(drives, 1)
        finally:
            drive_blocked.set_result(None)
            await sweep

    async def test_retains_uncertain_delivery_while_driving_broker_birth_recovery_periodically(self):
        self.h.db.install_active_binding(SCOPE, 'max3', iso_from_ms(self.h.now_ms()))
        envelope = self.h.ledger.say(body='delivery that triggers reprovision')
        dispatches = 0

        async def steer(*_args):
            nonlocal dispatches
            dispatches += 1
            now = iso_from_ms(self.h.now_ms())
            self.h.db.update_runtime(OLD_RUNTIME, status='stale', statusChangedAt=now, updatedAt=now)
            self.h.db.insert_runtime(dict(runtimeId=FAILED_RUNTIME, hostSessionId=self.h.session['hostSessionId'],
                                          scopeRef=SCOPE, laneRef='main', generation=self.h.session['generation'],
                                          transport='tmux', harness='codex-cli', provider='openai', status='failed',
                                          supportsInflightInput=True, createdAt=now, updatedAt=now))
            observe_mail_drive_lifecycle_event(self.context, self.broker_start_failed_event())
            raise Exception('interactive broker start failed')
        self.h.port.steer = steer

        self.assertEqual(await deliver_one_to(self.h, seat_in('idle'), envelope), 'refused')
        intent = self.h.store.mail_delivery.get_intent(envelope['id'])
        self.assertEqual((intent.uncertain_cause, intent.last_evidence_kind), ('dispatch_error', 'dispatch_error'))
        self.assertNotIn(envelope['id'], [item['envelope']['id']
                                          for item in await read_actionable_envelopes(self.context, TARGET)])
        self.assertEqual((await reconcile_open_intents(self.context, dict(reason='periodic')))['open'], 1)
        self.assertEqual(dispatches, 1)
        self.assertNotIn(TARGET, self.h.db.live_session_refs())

        refusal = self.h.store.mail_delivery.get_birth_refusal(TARGET)
        self.assertIn(envelope['id'], refusal.last_reason)
        self.assertIn('broker-invocation-start', refusal.last_reason)
        detail = self.h.events('wrkq.kicker.delivery_birth_refused')[0]['detail']
        self.assertLessEqual(dict(targetSessionRef=TARGET, envelope=envelope['id'], runtimeId=FAILED_RUNTIME,
                                  reason='broker-invocation-start').items(), detail.items())

        self.assertIn(TARGET, await unborn_birth_wake_candidates(self.context, self.h.db.live_session_refs()))

        driven = []

        async def drain_target(target):
            driven.append(dict(targetSessionRef=target,
                               wakeReason=self.context.mail_kicker_pending_targets.get(target)))
        self.context.drain_target = drain_target
        await run_mail_kicker_sweep(self.context)
        self.assertIn(dict(targetSessionRef=TARGET, wakeReason='periodic'), driven)


if __name__ == '__main__':
    unittest.main()
