"""T-08094 — the redelivery loop is BOUNDED (policy/__tests__/t08094-delivery-bounds.test.ts).

Only a correlated pre-write refusal may release an intent for another body
attempt. TTL, runtime loss, cancellation and every possible-write outcome
retain the fence.
"""
import asyncio
import time
import unittest
from unittest import mock

from mail_delivery import act_reconcile
from mail_delivery.act_internal import KICKER_SUBMISSION_TTL_MS
from mail_delivery.act_js import iso_from_ms
from mail_delivery.act_landing import observe_broker_landing
from mail_delivery.act_presentation import read_actionable_envelopes
from mail_delivery.act_reconcile import outstanding_runtime_reads, reconcile_open_intents
from .act_kicker_fake import RUNTIME_ID, TARGET_REF, Harness, broker_record, deliver_one_to, seat_in


class DeliveryBoundsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()
        self.store = self.h.store
        self.ledger = self.h.ledger
        self.context = self.h.context

    async def asyncTearDown(self):
        read = outstanding_runtime_reads.get(self.context)
        if read is not None:
            read['read'].cancel()
        await self.h.close()

    async def deliver_one(self, seat, envelope):
        return await deliver_one_to(self.h, seat, envelope)

    def age(self, envelope_id):
        self.h.sql('UPDATE hrcmail_delivery_intents SET submitted_at = ? WHERE envelope_id = ?',
                   (iso_from_ms(self.h.now_ms() - KICKER_SUBMISSION_TTL_MS - 1_000), envelope_id))

    async def actionable_ids(self):
        return [item['envelope']['id'] for item in await read_actionable_envelopes(self.context, TARGET_REF)]

    def event(self, type, payload, seq=1):
        self.h.db.append_event(dict(invocationId='inv-t08094', seq=seq, time=iso_from_ms(self.h.now_ms()),
                                    type=type, runtimeId=RUNTIME_ID, payload=payload))

    async def test_reuses_a_stalled_broad_runtime_read_while_a_later_matched_landing_commits(self):
        stalled = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), stalled)
        self.h.sql('UPDATE hrcmail_delivery_intents SET runtime_id = ?, submission_id = ? WHERE envelope_id = ?',
                   ('rt-runtime-read-stalled', 'sub-stalled', stalled['id']))
        matched = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), matched)
        self.event('submission.executed', dict(submissionId='sub-1', turnId='turn-matched'))

        stalled_reads = 0
        fallback = self.h.port.runtime

        async def runtime(runtime_id):
            nonlocal stalled_reads
            if runtime_id == 'rt-runtime-read-stalled':
                stalled_reads += 1
                return await asyncio.get_running_loop().create_future()
            return await fallback(runtime_id)
        self.h.port.runtime = runtime

        # The 2 s deadline is shortened for the test; the rule is the reuse.
        with mock.patch.object(act_reconcile, 'RECONCILE_RUNTIME_READ_DEADLINE_MS', 100):
            started = time.monotonic()
            counts = await reconcile_open_intents(self.context, dict(reason='periodic'))
            self.assertEqual((counts['landed'], counts['open']), (1, 1))
            self.assertLess(time.monotonic() - started, 0.1 + 1.0)
            self.assertEqual(self.store.mail_delivery.get_intent(stalled['id']).uncertain_cause,
                             'reconcile_runtime_read_timeout')
            self.assertEqual(len(self.ledger.envelopes[matched['id']]['presentedTo']), 1)
            self.assertEqual(stalled_reads, 1)

            await reconcile_open_intents(self.context, dict(reason='periodic'))
            self.assertEqual(stalled_reads, 1)
        self.assertEqual(self.ledger.fail_requests, [])

    async def test_holds_the_envelope_after_a_ttl_with_no_landing_proof(self):
        envelope = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), envelope)
        self.assertEqual((await reconcile_open_intents(self.context, dict(reason='periodic')))['open'], 1)
        self.age(envelope['id'])
        self.assertEqual((await reconcile_open_intents(self.context, dict(reason='periodic')))['open'], 1)
        self.assertEqual(self.store.mail_delivery.get_intent(envelope['id']).uncertain_cause, 'ttl_without_landing')
        self.assertEqual(self.ledger.envelopes[envelope['id']]['state'], 'pending')
        self.assertEqual(self.ledger.fail_requests, [])
        self.assertNotIn(envelope['id'], await self.actionable_ids())

    async def refuse_after_the_write_landed(self, reason):
        self.event('input.accepted', dict(inputId='sub-1', disposition='started'), seq=200)
        await observe_broker_landing(self.context, broker_record('submission.cancelled',
                                                                 dict(submissionId='sub-1', reason=reason)))

    async def test_holds_the_envelope_after_a_post_write_refusal(self):
        envelope = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), envelope)
        await self.refuse_after_the_write_landed('merged-into-foreign-turn')
        self.assertEqual(self.store.mail_delivery.get_intent(envelope['id']).uncertain_cause,
                         'merged-into-foreign-turn')
        self.assertEqual(self.ledger.fail_requests, [])
        self.assertNotIn(envelope['id'], await self.actionable_ids())

    async def test_does_not_strike_for_a_refusal_that_arrived_before_anything_was_written(self):
        envelope = self.ledger.say()
        for _ in range(4):
            await self.deliver_one(seat_in('turn-active'), envelope)
            await observe_broker_landing(self.context, broker_record('input.rejected', dict(
                inputId='sub-1', reason='pane_not_quiescent', deliveryEvidence='not_written')))
            self.assertEqual(self.store.mail_delivery.non_landing_strikes(envelope['id'], RUNTIME_ID), 0)
            self.assertIsNone(self.store.mail_delivery.get_intent(envelope['id']))
        self.assertEqual(self.ledger.fail_requests, [])
        self.assertEqual(self.ledger.envelopes[envelope['id']]['state'], 'pending')
        self.assertIn(envelope['id'], await self.actionable_ids())

    async def test_permits_a_retry_only_after_a_pre_write_refusal(self):
        envelope = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), envelope)
        await observe_broker_landing(self.context, broker_record('input.rejected', dict(
            inputId='sub-1', reason='pane_not_quiescent', deliveryEvidence='not_written')))
        self.assertEqual(self.store.mail_delivery.non_landing_strikes(envelope['id'], RUNTIME_ID), 0)
        self.assertIsNone(self.store.mail_delivery.get_intent(envelope['id']))
        self.assertIn(envelope['id'], await self.actionable_ids())
        self.assertEqual(self.ledger.fail_requests, [])

    async def test_retains_the_fence_when_a_rejection_has_no_correlated_no_write_proof(self):
        envelope = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), envelope)
        await observe_broker_landing(self.context, broker_record('input.rejected', dict(
            inputId='sub-1', reason='transport_lost')))
        self.assertEqual(self.store.mail_delivery.get_intent(envelope['id']).uncertain_cause, 'transport_lost')
        self.assertNotIn(envelope['id'], await self.actionable_ids())

    async def test_keeps_a_possibly_written_intent_fenced_after_the_submission_ttl(self):
        envelope = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), envelope)
        payload = dict(inputId='sub-1', reason='transport_lost', deliveryEvidence='possibly_written')
        self.event('input.rejected', payload)
        await observe_broker_landing(self.context, broker_record('input.rejected', payload))
        self.age(envelope['id'])
        self.assertEqual((await reconcile_open_intents(self.context, dict(reason='periodic')))['open'], 1)
        self.assertEqual(self.store.mail_delivery.get_intent(envelope['id']).uncertain_cause, 'input.rejected')
        self.assertNotIn(envelope['id'], await self.actionable_ids())
        self.assertEqual(len(self.h.dispatches), 1)
        self.assertEqual(self.h.wakes, [])
        self.assertEqual(self.store.mail_delivery.non_landing_strikes(envelope['id'], RUNTIME_ID), 0)

    async def test_keeps_uncertainty_scoped_to_the_original_envelope_and_runtime(self):
        envelope = self.ledger.say()
        await self.deliver_one(seat_in('turn-active'), envelope)
        self.age(envelope['id'])
        await reconcile_open_intents(self.context, dict(reason='periodic'))
        self.assertEqual(self.store.mail_delivery.get_intent(envelope['id']).uncertain_cause, 'ttl_without_landing')
        self.assertEqual(self.store.mail_delivery.non_landing_strikes(envelope['id'], 'rt-rotated'), 0)
        self.assertEqual(self.store.mail_delivery.non_landing_strikes(envelope['id'], RUNTIME_ID), 0)


if __name__ == '__main__':
    unittest.main()
