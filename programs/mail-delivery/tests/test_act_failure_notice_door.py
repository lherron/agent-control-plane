"""T-13292 — a failure notice uses the mail door and never holds the drive.

The Python port's own rule (Lance, 2026-11-11): a notice is steered when the
sender's seat is live and steer-capable, enqueued otherwise; a steered notice
counts as delivered when its landing fact arrives; no queued notice awaits its
enqueue answer inside the target's drive; one notice submission per target is
outstanding at a time. The TypeScript injector still enqueues and awaits.
"""
import asyncio
import time
import unittest

from mail_delivery.act_controller import MailKicker
from mail_delivery.act_failure_notices import deliver_failure_notices
from mail_delivery.act_internal import DISPOSAL_DRAIN_DEADLINE_MS
from mail_delivery.act_target_driver import drive_mail_target_once
from .act_kicker_fake import HOST_SESSION_ID, RUNTIME_ID, TARGET_REF, Harness, broker_record, settle

BOUND_S = 3


def seat_on(h, state, classes=('steer', 'queue')):
    async def runtimes_by_host_session(_host):
        return [dict(runtimeId=RUNTIME_ID, hostSessionId=HOST_SESSION_ID, generation=h.session['generation'],
                     status='busy' if state == 'turn-active' else 'ready', controllerKind='harness-broker',
                     activeInvocationId='inv-t08094')]

    async def seat(_runtime_id):
        return dict(runtimeId=RUNTIME_ID, invocationId='inv-t08094', generation=h.session['generation'],
                    admissionClasses=list(classes), currentBrokerSeq=0,
                    probe=dict(seat=dict(state=state, turnId='turn-1')), probeError=None)
    h.port.runtimes_by_host_session = runtimes_by_host_session
    h.port.seat = seat


class Doors:
    """Recording steer/enqueue seams; an enqueue answers only when the test says so."""

    def __init__(self, h, hold_enqueue=False):
        self.h = h
        self.calls = []
        self.steer_replies = []
        self.enqueue_answers = []
        self.hold_enqueue = hold_enqueue
        self.cancelled = 0
        h.port.steer = self.steer
        h.port.enqueue = self.enqueue

    def of(self, door):
        return [call for call in self.calls if call['door'] == door]

    async def steer(self, _session, _intent, prompt, options):
        self.calls.append(dict(door='steer', prompt=prompt, options=options))
        if self.steer_replies:
            reply = self.steer_replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        n = len(self.of('steer'))
        return dict(submissionId=f'sub-steer-{n}', admission='admitted', runtimeId=RUNTIME_ID)

    async def enqueue(self, _session, _intent, prompt, options):
        self.calls.append(dict(door='enqueue', prompt=prompt, options=options))
        if not self.hold_enqueue:
            return self.h.dispatch_result()
        answer = asyncio.get_running_loop().create_future()
        self.enqueue_answers.append(answer)
        try:
            return await answer
        except asyncio.CancelledError:
            self.cancelled += 1
            raise


def landed(submission_id, kind='submission.absorbed'):
    return broker_record(kind, dict(submissionId=submission_id, turnId='turn-1'))


class NoticeDoorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()

    async def asyncTearDown(self):
        await self.h.close()

    def record(self, envelope_id, notice):
        self.h.store.mail_delivery.record_failure_notice(envelope_id=envelope_id, target_session_ref=TARGET_REF,
                                                         notice=notice)

    def owed(self):
        return [notice.envelope_id for notice in self.h.store.mail_delivery.list_undelivered_failure_notices(TARGET_REF)]

    async def deliver(self):
        await asyncio.wait_for(deliver_failure_notices(self.h.context, TARGET_REF, self.h.session), BOUND_S)

    async def observe(self, record):
        self.h.context.observe_broker_event(record)
        await settle(10)

    async def test_steers_a_notice_into_a_turn_active_seat_and_marks_it_delivered_on_landing(self):
        seat_on(self.h, 'turn-active')
        doors = Doors(self.h)
        self.record('EN-1', 'notice one: your mail to x failed')
        await self.deliver()
        self.assertEqual([call['door'] for call in doors.calls], ['steer'])
        self.assertIn('notice one', doors.calls[0]['prompt'])
        self.assertEqual(self.owed(), ['EN-1'], 'admission is not landing')
        await self.deliver()
        self.assertEqual(len(doors.calls), 1, 'no second submission while the first is outstanding')
        await self.observe(landed('sub-steer-1'))
        self.assertEqual(self.owed(), [])
        delivered = self.h.events('wrkq.kicker.failure_notice_delivered')
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0]['detail']['door'], 'steer')
        self.assertEqual(delivered[0]['detail']['envelopes'], ['EN-1'])
        await self.deliver()
        self.assertEqual(len(doors.calls), 1)

    async def test_a_not_written_steer_refusal_falls_back_to_enqueue_once(self):
        seat_on(self.h, 'turn-active')
        doors = Doors(self.h)
        self.record('EN-1', 'notice one')
        await self.deliver()
        await self.observe(broker_record('submission.rejected', dict(
            submissionId='sub-steer-1', reason='pane_not_quiescent', deliveryEvidence='not_written')))
        self.assertEqual(self.owed(), ['EN-1'])
        for _ in range(3):
            await self.deliver()
        self.assertEqual([call['door'] for call in doors.calls], ['steer', 'enqueue'])
        self.assertEqual(self.owed(), [])
        self.assertEqual(self.h.events('wrkq.kicker.failure_notice_delivered')[0]['detail']['door'], 'enqueue')

    async def test_an_admission_rejected_steer_falls_back_to_enqueue_once(self):
        seat_on(self.h, 'turn-active')
        doors = Doors(self.h)
        doors.steer_replies.append(dict(submissionId='sub-r', admission='rejected', reason='guarded'))
        self.record('EN-1', 'notice one')
        for _ in range(3):
            await self.deliver()
        self.assertEqual([call['door'] for call in doors.calls], ['steer', 'enqueue'])
        self.assertEqual(self.owed(), [])

    async def test_a_steer_refusal_without_no_write_proof_leaves_the_rows_undelivered(self):
        seat_on(self.h, 'turn-active')
        doors = Doors(self.h)
        self.record('EN-1', 'notice one')
        await self.deliver()
        await self.observe(broker_record('submission.lost', dict(submissionId='sub-steer-1')))
        self.assertEqual(self.owed(), ['EN-1'])
        backoff = self.h.context.mail_kicker_failure_notice_backoff[TARGET_REF]
        self.assertEqual(backoff['attempts'], 1)
        self.assertEqual(self.h.events('wrkq.kicker.failure_notice_failed')[0]['detail']['door'], 'steer')
        self.assertEqual(doors.of('enqueue'), [], 'no proof of no write: no fallback door')

    async def test_a_drive_delivers_pending_mail_while_a_notice_enqueue_is_unanswered(self):
        seat_on(self.h, 'turn-active')
        doors = Doors(self.h, hold_enqueue=True)
        doors.steer_replies.append(dict(submissionId='sub-r', admission='rejected', reason='guarded'))
        self.record('EN-1', 'notice one')
        await self.deliver()  # steer refused at admission: the set falls back to enqueue
        envelope = self.h.ledger.say(id='EN-MAIL')
        await asyncio.wait_for(drive_mail_target_once(self.h.context, TARGET_REF, 'insert'), BOUND_S)
        self.assertEqual(len(doors.of('enqueue')), 1, 'the notice was enqueued')
        self.assertFalse(doors.enqueue_answers[0].done(), 'and HRC has not answered it')
        mail = [call for call in doors.of('steer') if call['options']['submissionOrigin'].get('envelopeId') == envelope['id']]
        self.assertEqual(len(mail), 1, 'the pending envelope was steered in the same drive')
        self.assertEqual(self.h.events('wrkq.kicker.drive_completed')[-1]['detail']['outcome'], 'completed')
        doors.enqueue_answers[0].set_result(self.h.dispatch_result())
        await settle(10)
        self.assertEqual(self.owed(), [])

    async def test_one_outstanding_notice_enqueue_then_one_submission_for_the_new_row(self):
        seat_on(self.h, 'idle', classes=('queue',))
        doors = Doors(self.h, hold_enqueue=True)
        self.record('EN-1', 'notice one')
        await self.deliver()
        self.record('EN-2', 'notice two')
        for _ in range(3):
            await self.deliver()
        self.assertEqual(len(doors.calls), 1)
        self.h.wakes.clear()
        doors.enqueue_answers[0].set_result(self.h.dispatch_result())
        await settle(10)
        self.assertEqual(self.owed(), ['EN-2'])
        self.assertEqual(self.h.wakes, [TARGET_REF], 'woken once for the row that was not part of it')
        await self.deliver()
        self.assertEqual(len(doors.calls), 2)
        self.assertIn('notice two', doors.calls[1]['prompt'])
        self.assertNotIn('notice one', doors.calls[1]['prompt'])

    async def test_one_outstanding_notice_steer_then_one_submission_for_the_new_row(self):
        seat_on(self.h, 'turn-active')
        doors = Doors(self.h)
        self.record('EN-1', 'notice one')
        await self.deliver()
        self.record('EN-2', 'notice two')
        await self.deliver()
        self.assertEqual(len(doors.calls), 1)
        self.h.wakes.clear()
        await self.observe(landed('sub-steer-1'))
        self.assertEqual(self.owed(), ['EN-2'])
        self.assertEqual(self.h.wakes, [TARGET_REF])
        await self.deliver()
        self.assertEqual([call['door'] for call in doors.calls], ['steer', 'steer'])
        self.assertIn('notice two', doors.calls[1]['prompt'])
        self.assertNotIn('notice one', doors.calls[1]['prompt'])

    async def test_a_resolved_notice_with_nothing_new_wakes_nobody(self):
        seat_on(self.h, 'idle', classes=('queue',))
        doors = Doors(self.h, hold_enqueue=True)
        self.record('EN-1', 'notice one')
        await self.deliver()
        self.h.wakes.clear()
        doors.enqueue_answers[0].set_result(self.h.dispatch_result())
        await settle(10)
        self.assertEqual(self.owed(), [])
        self.assertEqual(self.h.wakes, [])


class NoticeStopTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_with_a_notice_enqueue_unanswered_returns_within_the_drain_bound(self):
        h = Harness()
        try:
            seat_on(h, 'idle', classes=('queue',))
            doors = Doors(h, hold_enqueue=True)
            h.store.mail_delivery.record_failure_notice(envelope_id='EN-1', target_session_ref=TARGET_REF,
                                                        notice='notice one')
            h.context.mail_kicker_pending_targets[TARGET_REF] = 'insert'
            await asyncio.wait_for(MailKicker.drain_target(h.context, TARGET_REF), BOUND_S)
            self.assertEqual(len(doors.of('enqueue')), 1)
            self.assertEqual(len(h.events('wrkq.kicker.drive_completed')), 1, 'the drive did not wait for HRC')
            started = time.monotonic()
            await asyncio.wait_for(h.context.stop(), DISPOSAL_DRAIN_DEADLINE_MS / 1000 + 1)
            elapsed_ms = (time.monotonic() - started) * 1000
            self.assertLess(elapsed_ms, DISPOSAL_DRAIN_DEADLINE_MS)
            self.assertEqual(doors.cancelled, 1)
            self.assertEqual([task for task in h.context.tasks if not task.done()], [])
            self.assertEqual(h.store.mail_delivery.list_undelivered_failure_notices(TARGET_REF)[0].envelope_id, 'EN-1')
        finally:
            h.store.close()
            h.tmp.cleanup()


if __name__ == '__main__':
    unittest.main()
