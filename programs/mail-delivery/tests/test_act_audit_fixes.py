"""Side-by-side audit fixes (T-13283, ~/praesidium/var/wrkq-artifacts/T-13278/
audit-controller-port.md, items A to F): each pins the TypeScript behaviour on
an input where the first translation diverged."""
import asyncio
import json
import unittest

from mail_delivery import act_reconcile
from mail_delivery.act_controller import create_mail_kicker
from mail_delivery.act_cold_start import homed_target_session_refs, run_mail_kicker_cold_start_catchup
from mail_delivery.act_deferred import observe_deferred_wake
from mail_delivery.act_envelope_terminal import fail_envelope_with_audit
from mail_delivery.act_failure_notices import deliver_failure_notices
from mail_delivery.act_ledger_tail import wake_target_for_event, withdraw_acked_queued_injection
from mail_delivery.act_types import newest_presentation_receipt
from tests.act_fake import NOW, SCOPE, TARGET, FakeContext


def run(coroutine):
    return asyncio.run(coroutine)


class StubFacts:
    """Only the wrkq/HRC answers each case needs; every call is recorded."""

    def __init__(self, ctx):
        self.ctx = ctx


class ReconcileEvidence(unittest.TestCase):
    """A: reconcile.ts:211-221 tests `evidence === undefined`. An explicit null
    deliveryEvidence skips the mid-turn steer inference; only an absent one
    takes it."""

    def setUp(self):
        self.ctx = FakeContext()
        self.ctx.clock = NOW
        self.ctx.store.mail_delivery.open_intent(
            envelope_id='EN-00001', target_session_ref=TARGET, door='steer', form='full',
            presentation_id='present-1', submitted_hrc_seq=1, runtime_id='rt')
        self.ctx.store.mail_delivery.attach_admission('EN-00001', submission_id='sub-1')
        self.ctx.ledger.say(state='presented')
        self.ctx.clock = NOW + 120_000  # past STEER_WRITE_RECONCILE_GRACE_MS

    def tearDown(self):
        self.ctx.close()

    def reconcile(self, evidence_result):
        replies = {'disposition': {'result': None}, 'input-rejection-evidence': evidence_result,
                   'input-accepted': {'result': {'op': 'input-accepted', 'accepted': True}}}

        async def broker_events_query(op):
            self.ctx.transcript.append(dict(seam='port', method='broker_events_query', args=[op]))
            return replies[op['op']]
        self.ctx.port.broker_events_query = broker_events_query
        intent = self.ctx.store.mail_delivery.get_intent('EN-00001')
        return run(act_reconcile.reconcile_intent(self.ctx, intent, self.ctx.clock))

    def presents(self):
        return [t for t in self.ctx.transcript if t['method'] == 'present']

    def test_explicit_null_evidence_keeps_the_intent_open(self):
        verdict = self.reconcile({'result': {'op': 'input-rejection-evidence', 'deliveryEvidence': None}})
        self.assertEqual(verdict, 'open')
        self.assertEqual(self.presents(), [])
        self.assertFalse(any(t['args'][0].get('op') == 'input-accepted' for t in self.ctx.transcript
                             if t['method'] == 'broker_events_query'))

    def test_absent_evidence_takes_the_mid_turn_inference(self):
        verdict = self.reconcile({'result': None})
        self.assertEqual(verdict, 'landed')
        self.assertEqual(len(self.presents()), 1)

    def test_absent_evidence_key_takes_the_mid_turn_inference(self):
        verdict = self.reconcile({'result': {'op': 'input-rejection-evidence'}})
        self.assertEqual(verdict, 'landed')


class CommitWaitAnswers(unittest.IsolatedAsyncioTestCase):
    """B: a null commit.wait answer throws in the TypeScript (`initial.token`),
    which logs commit_follow_failed and retries; it never ends the loop."""

    async def test_null_answer_logs_and_retries(self):
        logs, waits = [], []

        class Port:
            async def events_head(self):
                return dict(hrcSeq=0, brokerCommit=0)

            async def subscribe_lifecycle(self, _input):
                async def unsubscribe():
                    return None
                return unsubscribe
            subscribe_broker = subscribe_lifecycle

        class Ledger:
            async def commit_wait(self, params):
                waits.append(params)
                if len(waits) == 1:
                    return None
                await asyncio.Event().wait()

        kicker = create_mail_kicker(
            dict(store=None, port=Port(), ledger=Ledger(), node_id='max3', foreign_home_memo={},
                 log=lambda level, event, detail: logs.append(event)),
            dict(enabled=True, sweep_interval_ms=10))

        async def nothing():
            return None
        kicker.run_tail_once = nothing
        await kicker.start()
        for _ in range(100):
            if len(waits) >= 2:
                break
            await asyncio.sleep(0.01)
        self.assertIn('wrkq.kicker.commit_follow_failed', logs)
        self.assertGreaterEqual(len(waits), 2)
        self.assertFalse(kicker.ledger_loop.done())
        await kicker.stop()


class StopAfterFailedUnsubscribe(unittest.IsolatedAsyncioTestCase):
    """C: an unsubscribe that raises must not leave the controller's tasks running."""

    async def test_survivors_are_cancelled_when_an_unsubscribe_raises(self):
        class Port:
            async def events_head(self):
                return dict(hrcSeq=0, brokerCommit=0)

            async def subscribe_lifecycle(self, _input):
                async def unsubscribe():
                    raise RuntimeError('unsubscribe failed')
                return unsubscribe
            subscribe_broker = subscribe_lifecycle

        class Ledger:
            async def commit_wait(self, params):
                await asyncio.Event().wait()

        kicker = create_mail_kicker(
            dict(store=None, port=Port(), ledger=Ledger(), node_id='max3', foreign_home_memo={},
                 log=lambda *_: None),
            dict(enabled=True, sweep_interval_ms=10))
        await kicker.start()
        hanging = kicker.spawn(asyncio.Event().wait())
        with self.assertRaises(RuntimeError):
            await kicker.stop()
        self.assertTrue(hanging.done())
        self.assertTrue(hanging.cancelled())


class ReceiptRanking(unittest.TestCase):
    """D: Date.parse(null) is NaN and ranks lowest; it never raises."""

    def test_null_presented_at_ranks_lowest(self):
        envelope = dict(presentedTo=[dict(runtimeId='a', presentedAt='2026-11-11T00:00:00.000Z'),
                                     dict(runtimeId='b', presentedAt=None)])
        self.assertEqual(newest_presentation_receipt(envelope)['runtimeId'], 'a')

    def test_all_unparseable_keeps_the_last(self):
        envelope = dict(presentedTo=[dict(runtimeId='a', presentedAt=None), dict(runtimeId='b')])
        self.assertEqual(newest_presentation_receipt(envelope)['runtimeId'], 'b')


class PayloadParsing(unittest.TestCase):
    """E: JSON.parse refuses NaN/Infinity literals."""

    def test_wake_target_refuses_a_nan_payload(self):
        payload = '{"to_scope_ref": "%s", "obligation": "reply_required", "n": NaN}' % SCOPE
        self.assertIsNone(wake_target_for_event(dict(eventType='envelope.created', payload=payload), set()))

    def test_withdraw_treats_an_unparseable_payload_as_unreadable(self):
        """An Infinity literal is unreadable to JSON.parse, so the fyi_presented
        early return does not apply and the ack is processed as before."""
        ctx = FakeContext()
        try:
            ctx.store.mail_delivery.open_intent(envelope_id='EN-00009', target_session_ref=TARGET, door='launch',
                                                form='full', presentation_id='present-9', submitted_hrc_seq=1)
            run(withdraw_acked_queued_injection(ctx, dict(
                eventType='envelope.acked', resourceId='EN-00009', payload='{"reason": "fyi_presented", "x": Infinity}')))
            self.assertEqual([log['event'] for log in ctx.logs], ['wrkq.kicker.queued_injection_withdraw_skipped'])
        finally:
            ctx.close()


class TolerantReads(unittest.TestCase):
    """F: where the TypeScript reads `undefined` from a missing field, so does the port."""

    def setUp(self):
        self.ctx = FakeContext()

    def tearDown(self):
        self.ctx.close()

    def test_cold_start_skips_a_binding_row_without_state_or_home(self):
        async def bindings():
            return dict(bindings=[dict(scopeRef=SCOPE), dict(scopeRef=SCOPE, state='active', homeNodeId='max3')])
        self.ctx.port.local_placement_bindings = bindings
        self.assertEqual(run(homed_target_session_refs(self.ctx)), [TARGET])

    def test_cold_start_tolerates_a_view_without_repended(self):
        async def bindings():
            return dict(bindings=[dict(scopeRef=SCOPE, state='active', homeNodeId='max3')])
        self.ctx.port.local_placement_bindings = bindings
        self.ctx.ledger.replies['pending_view'] = [dict(items=[])]
        run(run_mail_kicker_cold_start_catchup(self.ctx))
        self.assertEqual([log['event'] for log in self.ctx.logs], ['wrkq.kicker.cold_start_catchup'])

    def test_fail_tolerates_an_answer_without_state(self):
        self.ctx.ledger.say()
        self.ctx.ledger.replies['fail'] = [dict(id='EN-00001')]
        result = run(fail_envelope_with_audit(self.ctx, dict(
            envelope='EN-00001', reason='runtime_terminated', targetSessionRef=TARGET, callSite='lapsed_obligations')))
        self.assertEqual(result['outcome'], 'failed')
        failed = [log for log in self.ctx.logs if log['event'] == 'wrkq.kicker.envelope_failed'][0]
        self.assertNotIn('state', failed['detail'])

    def test_deferred_ignores_an_envelope_without_state(self):
        self.ctx.ledger.replies['envelope_show'] = [dict(id='EN-00001', retryAt='2026-11-11T00:00:00.000Z')]
        run(observe_deferred_wake(self.ctx, 'EN-00001'))
        self.assertEqual(self.ctx.logs, [])

    def test_notice_for_a_seat_without_runtime_id_raises_before_any_enqueue(self):
        """Not a tolerant read: the TypeScript hashes the undefined runtimeId with
        createHash().update(undefined), which throws ERR_INVALID_ARG_TYPE before
        the enqueue (checked under bun). The port raises at the same point."""
        self.ctx.store.mail_delivery.record_failure_notice(envelope_id='EN-00001', target_session_ref=TARGET,
                                                           notice='notice')
        import mail_delivery.act_failure_notices as notices
        original = notices.observe_broker_seat

        async def seat_without_runtime(_server, _session):
            return dict(state='idle')
        notices.observe_broker_seat = seat_without_runtime
        try:
            with self.assertRaises(Exception):
                run(deliver_failure_notices(self.ctx, TARGET, self.ctx.port.session))
        finally:
            notices.observe_broker_seat = original
        self.assertFalse(any(t['method'] == 'enqueue' for t in self.ctx.transcript))

    def test_notice_enqueue_answer_without_status_is_parked(self):
        """`body.status !== 'started'` holds for an undefined status."""
        self.ctx.store.mail_delivery.record_failure_notice(envelope_id='EN-00001', target_session_ref=TARGET,
                                                           notice='notice')
        self.ctx.port.probe['admissionClasses'] = ['enqueue']  # T-13292: a steer-capable seat is steered
        self.ctx.port.replies['enqueue'] = [dict(runId='run-1')]
        run(deliver_failure_notices(self.ctx, TARGET, self.ctx.port.session))
        parked = [log for log in self.ctx.logs if log['event'] == 'wrkq.kicker.failure_notice_parked']
        self.assertEqual(len(parked), 1)
        self.assertNotIn('status', parked[0]['detail'])

    def test_events_head_without_hrc_seq_still_subscribes(self):
        """TypeScript destructures undefined and subscribes from it."""
        subscribed = []

        class Port:
            async def events_head(self):
                return {}

            async def subscribe_lifecycle(self, input):
                subscribed.append(input.get('afterSeq', 'missing'))

                async def unsubscribe():
                    return None
                return unsubscribe

            async def subscribe_broker(self, input):
                subscribed.append(input.get('afterCommit', 'missing'))

                async def unsubscribe():
                    return None
                return unsubscribe

        class Ledger:
            async def commit_wait(self, params):
                await asyncio.Event().wait()

        async def scenario():
            kicker = create_mail_kicker(dict(store=None, port=Port(), ledger=Ledger(), node_id='max3',
                                             foreign_home_memo={}, log=lambda *_: None),
                                        dict(enabled=True, sweep_interval_ms=10))
            await kicker.start()
            await kicker.stop()
        run(scenario())
        self.assertEqual(subscribed, [None, None])

if __name__ == '__main__':
    unittest.main()
