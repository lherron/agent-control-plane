"""T-11680: the periodic sweep drives a target only for outstanding mail or a
changed state (policy/__tests__/t11680-quiet-periodic-sweep.test.ts)."""
import unittest

from mail_delivery.act_internal import PERIODIC_QUIET_BACKSTOP_MS
from mail_delivery.act_quiet_targets import record_periodic_drive
from mail_delivery.act_reconcile import reconcile_open_intents
from mail_delivery.act_runtime_lapse import sweep_lapsed_obligations
from mail_delivery.act_sweep import run_mail_kicker_sweep
from mail_delivery.act_target_driver import drive_mail_target_once
from .act_kicker_fake import RUNTIME_ID, TARGET_REF, Harness, settle

STALE = 'agent:cody:project:agent-control-plane:task:T-stale/lane:main'


class QuietPeriodicSweepTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()
        self.drained = []
        self.drive_outcome = dict(outcome='empty')

        async def drain_target(target):
            self.drained.append(target)
            record_periodic_drive(self.h.context, target, self.drive_outcome)
        self.h.context.drain_target = drain_target

    async def asyncTearDown(self):
        await self.h.close()

    async def sweep(self):
        self.drained = []
        await run_mail_kicker_sweep(self.h.context)
        await settle()  # the sweep spawns its drains; let them run
        return self.drained

    def owe(self, envelope_id):
        self.h.store.mail_delivery.record_failure_notice(envelope_id=envelope_id, target_session_ref=STALE,
                                                         notice='sender failure')

    async def test_drives_an_unchanged_notice_only_target_once_then_leaves_it_alone(self):
        self.owe('EN-90001')
        self.assertIn(STALE, await self.sweep())
        self.assertNotIn(STALE, await self.sweep())
        self.assertNotIn(STALE, await self.sweep())

    async def test_keeps_driving_a_seated_target_with_pending_mail_on_every_sweep(self):
        self.h.ledger.say()
        self.assertIn(TARGET_REF, await self.sweep())
        self.assertIn(TARGET_REF, await self.sweep())

    async def test_re_drives_a_quiet_target_on_a_new_notice_a_due_notice_backoff_or_the_backstop(self):
        self.owe('EN-90001')
        await self.sweep()
        self.assertNotIn(STALE, await self.sweep())

        self.owe('EN-90002')
        self.assertIn(STALE, await self.sweep())
        self.assertNotIn(STALE, await self.sweep())

        self.h.context.mail_kicker_failure_notice_backoff[STALE] = dict(
            key='notice-key', exhausted=False, attempts=1, nextAtMs=self.h.now_ms() - 1)
        self.assertIn(STALE, await self.sweep())
        self.h.context.mail_kicker_failure_notice_backoff.pop(STALE)
        self.assertNotIn(STALE, await self.sweep())

        quiet = self.h.context.mail_kicker_quiet_targets[STALE]
        quiet['quietSinceMs'] -= PERIODIC_QUIET_BACKSTOP_MS
        self.assertIn(STALE, await self.sweep())

    async def test_does_not_go_quiet_on_a_drive_that_did_anything_but_find_nothing(self):
        self.owe('EN-90001')
        self.drive_outcome = None
        await self.sweep()
        self.assertIn(STALE, await self.sweep())

    async def test_ignores_the_timestamp_reconcile_rewrites_not_a_changed_intent(self):
        self.h.store.mail_delivery.open_intent(envelope_id='EN-90003', target_session_ref=STALE, door='steer',
                                               form='full', presentation_id='present-90003', submitted_hrc_seq=1)
        self.assertIn(STALE, await self.sweep())
        self.assertNotIn(STALE, await self.sweep())

        self.h.sql('UPDATE hrcmail_delivery_intents SET updated_at = ? WHERE envelope_id = ?',
                   ('2099-01-01T00:00:00.000Z', 'EN-90003'))
        self.assertNotIn(STALE, await self.sweep())

        self.h.sql('UPDATE hrcmail_delivery_intents SET uncertain_cause = ? WHERE envelope_id = ?',
                   ('ttl_without_landing', 'EN-90003'))
        self.assertIn(STALE, await self.sweep())
        self.assertNotIn(STALE, await self.sweep())
        original = self.h.port.live_session_refs

        async def live_session_refs():
            return [*(await original()), STALE]
        self.h.port.live_session_refs = live_session_refs
        self.assertIn(STALE, await self.sweep())

    async def test_reports_an_empty_drive_so_the_sweep_can_tell_nothing_was_outstanding(self):
        self.assertEqual(await drive_mail_target_once(self.h.context, TARGET_REF, 'periodic'), dict(outcome='empty'))


class QuietReconcileTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()
        self.reads = 0
        runtime = self.h.port.runtime

        async def counted(runtime_id):
            self.reads += 1
            return await runtime(runtime_id)
        self.h.port.runtime = counted

    async def asyncTearDown(self):
        await self.h.close()

    def open_on_gone_runtime(self, envelope_id):
        self.h.ledger.say(id=envelope_id)
        self.h.store.mail_delivery.open_intent(envelope_id=envelope_id, target_session_ref=STALE, door='enqueue',
                                               form='full', presentation_id=f'present-{envelope_id}',
                                               runtime_id='rt-long-gone', submitted_hrc_seq=1)

    async def test_leaves_a_settled_uncertain_intent_to_the_backstop_on_periodic_passes(self):
        self.open_on_gone_runtime('EN-90010')
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        self.assertEqual(self.reads, 1)
        self.assertEqual(self.h.store.mail_delivery.get_intent('EN-90010').uncertain_cause,
                         'runtime_terminated_before_landing')
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        self.assertEqual(self.reads, 1)
        examined_at = self.h.context.mail_kicker_reconcile_examined_at['EN-90010']
        self.h.context.mail_kicker_reconcile_examined_at['EN-90010'] = examined_at - PERIODIC_QUIET_BACKSTOP_MS
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        self.assertEqual(self.reads, 2)

    async def test_still_examines_every_intent_at_daemon_start_and_on_runtime_termination(self):
        self.open_on_gone_runtime('EN-90011')
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        self.assertEqual(self.reads, 1)
        await reconcile_open_intents(self.h.context, dict(reason='daemon_start'))
        self.assertEqual(self.reads, 2)
        await reconcile_open_intents(self.h.context, dict(reason='runtime_terminated', runtimeIds={'rt-long-gone'}))
        self.assertEqual(self.reads, 3)

    async def test_keeps_examining_an_in_flight_intent_and_a_runtime_read_timeout_every_pass(self):
        self.h.store.mail_delivery.open_intent(envelope_id='EN-90012', target_session_ref=TARGET_REF, door='enqueue',
                                               form='full', presentation_id='present-EN-90012', runtime_id=RUNTIME_ID,
                                               submitted_hrc_seq=1)
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        self.assertEqual(self.reads, 2)
        self.h.store.mail_delivery.mark_uncertain('EN-90012', 'reconcile_runtime_read_timeout', 'runtime_read_timeout')
        await reconcile_open_intents(self.h.context, dict(reason='periodic'))
        self.assertEqual(self.reads, 3)

    async def test_inspects_a_live_presentation_runtime_once_then_again_only_at_the_backstop(self):
        self.h.store.mail_delivery.record_presentation(
            envelope_id='EN-90020', runtime_id=RUNTIME_ID, target_session_ref=TARGET_REF, generation=1,
            presentation_id='present-EN-90020', delivery_outcome='steered', landing_hrc_seq=10)
        await sweep_lapsed_obligations(self.h.context)
        await sweep_lapsed_obligations(self.h.context)
        await sweep_lapsed_obligations(self.h.context)
        self.assertEqual(self.reads, 1)
        seen_live_at = self.h.context.mail_kicker_live_runtime_seen_at[RUNTIME_ID]
        self.h.context.mail_kicker_live_runtime_seen_at[RUNTIME_ID] = seen_live_at - PERIODIC_QUIET_BACKSTOP_MS
        await sweep_lapsed_obligations(self.h.context)
        self.assertEqual(self.reads, 2)


if __name__ == '__main__':
    unittest.main()
