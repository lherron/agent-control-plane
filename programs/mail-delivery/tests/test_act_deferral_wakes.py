"""T-12512 event-driven deferral deadlines (policy/__tests__/t12512-deferral-wakes.test.ts)."""
import asyncio
import math
import unittest
from unittest import mock

from mail_delivery import act_deferred
from mail_delivery.act_deferred import (forget_deferred_wake, next_deferred_wake_at, observe_deferred_wake,
                                        stop_deferred_wakes)
from mail_delivery.act_js import iso_from_ms
from .act_kicker_fake import TARGET_REF, Harness


class DeferralWakeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()
        self.wakes = []
        self.reads = 0
        self.h.context.wake = lambda target, reason=None: self.wakes.append(target)

        async def pending_view(params):
            self.assertEqual(params['scopes'], [TARGET_REF])
            self.reads += 1
            return dict(items=[dict(envelope, state='pending') for envelope in self.h.ledger.envelopes.values()],
                        blocking=[], repended=1)
        self.h.ledger.pending_view = pending_view

    async def asyncTearDown(self):
        self.h.context.stopping = True
        stopped = stop_deferred_wakes(self.h.context)
        if stopped is not None:
            await asyncio.wait([stopped])
        await self.h.close()

    async def test_repends_an_overdue_deferral_once_and_wakes_only_its_target(self):
        envelope = self.h.ledger.say(state='deferred', retryAt='2020-01-01T00:00:00Z')
        await observe_deferred_wake(self.h.context, envelope['id'])
        await asyncio.sleep(0.03)
        self.assertEqual(self.reads, 1)
        self.assertEqual(self.wakes, [TARGET_REF])
        await asyncio.sleep(0.03)
        self.assertEqual(self.reads, 1)

    async def test_keeps_a_due_envelope_until_the_ledger_exposes_it_on_a_bounded_re_arm(self):
        envelope = self.h.ledger.say(state='deferred', retryAt='2020-01-01T00:00:00Z')

        async def pending_view(params):
            self.reads += 1
            if self.reads == 1:
                return dict(items=[], blocking=[], repended=0)
            envelope['state'] = 'pending'
            return dict(items=[envelope], blocking=[], repended=1)
        self.h.ledger.pending_view = pending_view
        # The first re-arm backoff (1000 ms) is shortened; the bounded re-arm is the rule.
        with mock.patch.object(act_deferred, 'REPEND_BACKOFF_MS', (100, 2000, 5000)):
            await observe_deferred_wake(self.h.context, envelope['id'])
            await asyncio.sleep(0.05)
            self.assertEqual(self.reads, 1)
            self.assertEqual(self.wakes, [])
            self.assertTrue(math.isfinite(next_deferred_wake_at(self.h.context)))
            await asyncio.sleep(0.2)
            self.assertEqual(self.reads, 2)
            self.assertEqual(self.wakes, [TARGET_REF])
            self.assertEqual(next_deferred_wake_at(self.h.context), math.inf)

    async def test_gives_the_ledger_a_full_second_beyond_its_whole_second_retry_boundary(self):
        at = math.ceil((self.h.now_ms() + 60_000) / 1000) * 1000
        envelope = self.h.ledger.say(state='deferred', retryAt=iso_from_ms(at))
        await observe_deferred_wake(self.h.context, envelope['id'])
        self.assertEqual(next_deferred_wake_at(self.h.context), at + 1000)

    async def test_does_no_idle_remote_reads_and_cancels_a_terminal_deferral_before_it_is_due(self):
        envelope = self.h.ledger.say(state='deferred', retryAt=iso_from_ms(self.h.now_ms() + 60_000))
        await observe_deferred_wake(self.h.context, envelope['id'])
        forget_deferred_wake(self.h.context, envelope['id'])
        await asyncio.sleep(0.03)
        self.assertEqual(self.reads, 0)
        self.assertEqual(self.wakes, [])

    async def test_ignores_indefinite_deferrals_and_foreign_recipients(self):
        indefinite = self.h.ledger.say(state='deferred')
        await observe_deferred_wake(self.h.context, indefinite['id'])

        async def foreign(_scope_ref):
            return dict(homeNodeId='svc', source='registry')
        self.h.port.resolve_foreign_home = foreign
        other = self.h.ledger.say(state='deferred', retryAt='2020-01-01T00:00:00Z')
        await observe_deferred_wake(self.h.context, other['id'])
        await asyncio.sleep(0.03)
        self.assertEqual(self.reads, 0)
        self.assertEqual(self.wakes, [])

    async def test_retains_due_work_after_a_failed_repend_and_logs_a_bounded_retry(self):
        async def pending_view(params):
            self.reads += 1
            raise Exception('wrkq offline')
        self.h.ledger.pending_view = pending_view
        envelope = self.h.ledger.say(state='deferred', retryAt='2020-01-01T00:00:00Z')
        await observe_deferred_wake(self.h.context, envelope['id'])
        await asyncio.sleep(0.05)
        self.assertEqual(self.reads, 1)
        self.assertEqual(self.wakes, [])
        self.assertTrue(self.h.events('wrkq.kicker.deferral_wake_failed'))

    async def test_stop_waits_for_an_in_flight_repend_and_suppresses_its_late_wake(self):
        gate = asyncio.get_running_loop().create_future()

        async def pending_view(params):
            self.reads += 1
            await gate
            return dict(items=[], blocking=[], repended=1)
        self.h.ledger.pending_view = pending_view
        envelope = self.h.ledger.say(state='deferred', retryAt='2020-01-01T00:00:00Z')
        await observe_deferred_wake(self.h.context, envelope['id'])
        await asyncio.sleep(0.03)
        self.assertEqual(self.reads, 1)
        self.h.context.stopping = True
        stopped = stop_deferred_wakes(self.h.context)
        gate.set_result(None)
        await stopped
        self.assertEqual(self.wakes, [])


if __name__ == '__main__':
    unittest.main()
