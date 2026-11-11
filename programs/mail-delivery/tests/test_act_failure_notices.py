"""Sender failure notices: dispatch idempotency, obligation, live seat
(policy/__tests__/failure-notice-idempotency.test.ts, failure-notice-obligation.test.ts,
t11970-failure-notice-live-seat.test.ts)."""
import json
import re
import unittest

from mail_delivery.act_failure_notices import deliver_failure_notices, queue_failure_notice
from .act_kicker_fake import SCOPE_REF, TARGET_REF, Harness


def present_on(h, runtime_id):
    async def runtimes_by_host_session(_host):
        return [dict(runtimeId=runtime_id, generation=h.session['generation'], status='ready',
                     controllerKind='harness-broker', activeInvocationId=f'inv-{runtime_id}')]

    async def seat(_runtime_id):
        return dict(runtimeId=runtime_id, invocationId=f'inv-{runtime_id}', generation=h.session['generation'],
                    admissionClasses=['enqueue'], currentBrokerSeq=0, probe=dict(seat=dict(state='idle')),
                    probeError=None)
    h.port.runtimes_by_host_session = runtimes_by_host_session
    h.port.seat = seat


class FailureNoticeIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()

    async def asyncTearDown(self):
        await self.h.close()

    def owed(self):
        return self.h.store.mail_delivery.list_undelivered_failure_notices(TARGET_REF)

    def record(self, envelope_id, notice):
        self.h.store.mail_delivery.record_failure_notice(envelope_id=envelope_id, target_session_ref=TARGET_REF,
                                                         notice=notice)

    async def deliver(self):
        await deliver_failure_notices(self.h.context, TARGET_REF, self.h.session)

    async def test_replays_one_stable_hrc_dispatch_after_a_lost_response(self):
        present_on(self.h, 'rt-t08094')
        self.record('EN-15268', 'retired sender failure')
        self.record('EN-15281', 'retired recovery failure')
        attempts = []

        async def enqueue(_session, _intent, _prompt, options):
            attempts.append(options)
            if len(attempts) == 1:
                raise Exception('dispatch response timed out after acceptance')
            return self.h.dispatch_result()
        self.h.port.enqueue = enqueue

        await self.deliver()
        self.assertEqual(len(self.owed()), 2)
        await self.deliver()
        self.assertEqual(len(attempts), 2)
        self.assertRegex(attempts[0]['idempotencyKey'], r'^hrc-mail-failure-notice-[0-9a-f]{64}$')
        self.assertEqual(attempts[1]['idempotencyKey'], attempts[0]['idempotencyKey'])
        self.assertEqual(len(self.owed()), 0)
        await self.deliver()
        self.assertEqual(len(attempts), 2)

    async def test_parks_a_notice_whose_stable_dispatch_replays_a_failed_start_until_the_sender_reseats(self):
        self.record('EN-19187', 'assessment to lance failed')
        present_on(self.h, 'rt-stuck')
        attempts = []

        async def failed(_session, _intent, _prompt, options):
            attempts.append(options)
            return dict(self.h.dispatch_result(), status='failed', replayed=len(attempts) > 1)
        self.h.port.enqueue = failed
        for _ in range(5):
            await self.deliver()
        self.assertEqual(len(attempts), 1)
        self.assertEqual(len(self.owed()), 1)

        self.record('EN-19372', 'second assessment to lance failed')
        await self.deliver()
        await self.deliver()
        self.assertEqual(len(attempts), 2)

        present_on(self.h, 'rt-reseated')

        async def started(_session, _intent, _prompt, options):
            attempts.append(options)
            return self.h.dispatch_result()
        self.h.port.enqueue = started
        await self.deliver()
        self.assertEqual(len(attempts), 3)
        self.assertNotEqual(attempts[2]['idempotencyKey'], attempts[1]['idempotencyKey'])
        self.assertEqual(len(self.owed()), 0)

    async def test_backs_off_a_sender_whose_seat_keeps_refusing_the_notice(self):
        self.record('EN-19188', 'assessment to lance failed')
        present_on(self.h, 'rt-detached')
        attempts = 0

        async def refusing(*_args):
            nonlocal attempts
            attempts += 1
            raise Exception('participant attempt pa-1 is DETACHED with an exhausted reconnect budget after 5 attempt(s)')
        self.h.port.enqueue = refusing
        for _ in range(10):
            await self.deliver()
        self.assertEqual(attempts, 2)
        self.assertEqual(len(self.owed()), 1)

        present_on(self.h, 'rt-reattached')

        async def accepting(*_args):
            nonlocal attempts
            attempts += 1
            return self.h.dispatch_result()
        self.h.port.enqueue = accepting
        await self.deliver()
        self.assertEqual(attempts, 2)
        self.h.advance(60 * 60_000)
        await self.deliver()
        self.assertEqual(attempts, 3)
        self.assertEqual(len(self.owed()), 0)


class FailureNoticeObligationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()

    async def asyncTearDown(self):
        await self.h.close()

    async def fail_as(self, obligation):
        envelope = self.h.ledger.say(obligation=obligation, **{'from': dict(principalRef='agent:clod',
                                                                            scopeRef=SCOPE_REF)})
        await queue_failure_notice(self.h.context, dict(resourceId=envelope['id'], payload=json.dumps(dict(
            state='failed', reason='undeliverable', detail='envelope_ttl_expired'))))
        return envelope

    async def test_queues_no_notice_for_a_failed_fyi_or_notify(self):
        await self.fail_as('fyi')
        await self.fail_as('notify')
        self.assertEqual(self.h.store.mail_delivery.list_undelivered_failure_notices(TARGET_REF), [])
        self.assertEqual(self.h.wakes, [])

    async def test_still_queues_the_notice_for_a_failed_reply_required(self):
        envelope = await self.fail_as('reply_required')
        queued = self.h.store.mail_delivery.list_undelivered_failure_notices(TARGET_REF)
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].envelope_id, envelope['id'])
        self.assertIn('Resend or escalate', queued[0].notice)
        self.assertEqual(self.h.wakes, [TARGET_REF])


class FailureNoticeLiveSeatTests(unittest.IsolatedAsyncioTestCase):
    """T-11970 — a failure notice rides a live seat and never births one."""

    async def asyncSetUp(self):
        self.h = Harness()
        self.rows = []
        self.probes = {}
        self.born = 0

        async def runtimes_by_host_session(_host):
            return list(self.rows)

        async def seat(runtime_id):
            state = self.probes.get(runtime_id)
            return dict(runtimeId=runtime_id, invocationId=f'inv-{runtime_id}', generation=self.h.session['generation'],
                        admissionClasses=['enqueue'], currentBrokerSeq=0,
                        probe=None if state is None else dict(seat=dict(state=state, turnId='turn-1')),
                        probeError=dict(code='broker_unreachable', message='connect ENOENT') if state is None else None)
        self.h.port.runtimes_by_host_session = runtimes_by_host_session
        self.h.port.seat = seat
        self.h.store.mail_delivery.record_failure_notice(
            envelope_id='EN-35866', target_session_ref=TARGET_REF,
            notice='reply_required to cody@hrc-runtime:T-11818 failed: undeliverable')

    async def asyncTearDown(self):
        await self.h.close()

    def seat_runtime(self, runtime_id, state):
        self.rows.append(dict(runtimeId=runtime_id, hostSessionId=self.h.session['hostSessionId'],
                              generation=self.h.session['generation'], status='ready',
                              controllerKind='harness-broker', activeInvocationId=f'inv-{runtime_id}'))
        self.probes[runtime_id] = state

    def enqueues(self):
        return len([dispatch for dispatch in self.h.dispatches if dispatch['submissionDoor'] == 'enqueue'])

    def owed(self):
        return len(self.h.store.mail_delivery.list_undelivered_failure_notices(TARGET_REF))

    async def deliver(self):
        await deliver_failure_notices(self.h.context, TARGET_REF, self.h.session)

    async def test_submits_nothing_for_a_sender_with_no_live_seat_however_many_passes_run(self):
        self.seat_runtime('rt-born-0', None)

        async def births_a_dead_runtime(_session, _intent, _prompt, options):
            self.h.dispatches.append(dict(options, submissionDoor='enqueue'))
            self.born += 1
            self.seat_runtime(f'rt-born-{self.born}', None)
            raise Exception('POST /v1/submissions/enqueue 500: connect ENOENT '
                            '/private/tmp/spaces-harness-broker-501/hb-codex-tui.app.sock')
        self.h.port.enqueue = births_a_dead_runtime
        for _ in range(10):
            await self.deliver()
        self.assertEqual(self.enqueues(), 0)
        self.assertEqual(self.born, 0)
        self.assertEqual(self.owed(), 1)

        self.rows = []
        await self.deliver()
        self.assertEqual(self.enqueues(), 0)

        async def accepting(_session, _intent, _prompt, options):
            self.h.dispatches.append(dict(options, submissionDoor='enqueue'))
            return self.h.dispatch_result()
        self.h.port.enqueue = accepting
        self.seat_runtime('rt-returned', 'idle')
        await self.deliver()
        self.assertEqual(self.enqueues(), 1)
        self.assertEqual(self.owed(), 0)

    async def test_delivers_once_into_a_live_seat(self):
        self.seat_runtime('rt-live', 'turn-active')
        for _ in range(3):
            await self.deliver()
        self.assertEqual(self.enqueues(), 1)
        self.assertEqual(self.owed(), 0)
        self.assertIn('wrkq.kicker.failure_notice_delivered', [entry['event'] for entry in self.h.logs])

    async def test_keeps_its_backoff_across_a_runtime_change_then_parks_with_a_warn(self):
        seat = 0

        def reseat():
            nonlocal seat
            seat += 1
            self.rows = []
            self.seat_runtime(f'rt-live-{seat}', 'idle')
        reseat()

        async def detached(_session, _intent, _prompt, options):
            self.h.dispatches.append(dict(options, submissionDoor='enqueue'))
            raise Exception('participant attempt is DETACHED')
        self.h.port.enqueue = detached
        for _ in range(10):
            await self.deliver()
            reseat()
        self.assertEqual(self.enqueues(), 2)

        for _ in range(40):
            self.h.advance(60 * 60_000)
            await self.deliver()
            reseat()
        parked = self.h.events('wrkq.kicker.failure_notice_parked')
        self.assertEqual(len(parked), 1)
        self.assertEqual(parked[0]['level'], 'WARN')
        self.assertEqual(parked[0]['detail']['reason'], 'attempts_exhausted')
        spent = self.enqueues()
        self.assertLess(spent, 10)
        self.assertEqual(self.owed(), 1)

        self.h.store.mail_delivery.record_failure_notice(envelope_id='EN-35900', target_session_ref=TARGET_REF,
                                                         notice='a second reply_required failed')
        await self.deliver()
        self.assertEqual(self.enqueues(), spent + 1)


if __name__ == '__main__':
    unittest.main()
