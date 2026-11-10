import json
from pathlib import Path
import tempfile
from unittest import TestCase
from mail_delivery.memos import Memos, InjectorLogFeeder, OwnOutcomeFeeder


def event(name, **data):
    return dict(ts='2026-11-10T12:00:00Z', event=name, data=data)


class MemoFeeders(TestCase):
    def test_latest_start_replay_partial_line_restart_and_unknown_event(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'injector.log'
            records = [event('mail_injector.started'),
                       event('wrkq.kicker.landing_refused', envelope='old', runtimeId='rt',
                             door='steer', fallbackDoor='enqueue', refusalClass='permanent'),
                       event('mail_injector.started'), event('future.event'),
                       event('wrkq.kicker.unborn_birth_retry', targetSessionRef='target',
                             attempt=2, nextAttemptInMs=120000)]
            path.write_text(''.join(json.dumps(r)+'\n' for r in records) + '{')
            memos = Memos()
            feeder = InjectorLogFeeder(path, memos)
            feeder.poll()
            self.assertTrue(memos.anchored)
            self.assertNotIn('old', memos.fallback)
            self.assertEqual(memos.birth['target']['attempts'], 2)
            with path.open('a') as f:
                f.write('}\n'+json.dumps(event('mail_injector.started'))+'\n')
            feeder.poll()
            self.assertEqual(memos.birth, {})

    def test_same_memo_interface_and_broker_movement(self):
        memos = Memos()
        own = OwnOutcomeFeeder(memos)
        own.accept(event('mail_injector.started'))
        own.accept(event('wrkq.kicker.landing_refused', envelope='EN-1', runtimeId='rt',
                         door='steer', reason='pane_not_quiescent', retryInMs=2000,
                         refusalClass='not_written'))
        self.assertIn('rt', memos.quiet)
        memos.broker('rt', {'type': 'submission.rejected', 'seq': 3,
                           'invocationId': 'inv', 'time': '2026-11-10T12:00:01Z'})
        self.assertIn('rt', memos.quiet)
        memos.broker('rt', {'type': 'tool.started', 'seq': 4,
                           'invocationId': 'inv', 'time': '2026-11-10T12:00:02Z'})
        self.assertNotIn('rt', memos.quiet)

    def test_rotation_without_restart_anchor_does_not_guess_empty_state(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'injector.log'
            path.write_text(json.dumps(event('future.event'))+'\n')
            memos = Memos()
            InjectorLogFeeder(path, memos).poll()
            self.assertFalse(memos.anchored)

    def test_admission_fallback_recovers_runtime_and_clears_on_enqueue_attempt(self):
        memos = Memos()
        memos.accept(event('mail_injector.started'))
        memos.accept(event('wrkq.kicker.delivery_intent', envelope='EN-1', runtimeId='rt', door='steer'))
        memos.accept(event('wrkq.kicker.landing_refused', envelope='EN-1', door='steer',
                          phase='admission', reason='steer_not_supported', fallbackDoor='enqueue'))
        self.assertIn('rt', memos.capability)
        memos.accept(event('wrkq.kicker.delivery_intent', envelope='EN-1', runtimeId='rt', door='enqueue'))
        self.assertNotIn('EN-1', memos.fallback)

    def test_unknown_admission_layer_is_a_named_unknown_not_a_policy_guess(self):
        memos = Memos()
        memos.accept(event('mail_injector.started'))
        memos.accept(event('wrkq.kicker.delivery_intent', envelope='EN-1', runtimeId='rt', door='steer'))
        memos.accept(event('wrkq.kicker.landing_refused', envelope='EN-1', door='steer',
                          phase='admission', reason='unknown', fallbackDoor='enqueue'))
        self.assertIsNone(memos.fallback['EN-1'])

    def test_digest_member_logs_do_not_double_charge_runtime_retry(self):
        memos = Memos()
        memos.accept(event('mail_injector.started'))
        for envelope in ('EN-1', 'EN-2'):
            memos.accept(event('wrkq.kicker.landing_refused', envelope=envelope, runtimeId='rt',
                door='steer', reason='pane_not_quiescent', retryInMs=2000, refusalClass='not_written'))
        self.assertEqual(memos.backoff['rt']['attempts'], 1)

    def test_long_not_hosted_backoff_is_preserved(self):
        memos = Memos()
        memos.accept(event('mail_injector.started'))
        memos.accept(event('wrkq.kicker.unborn_birth_retry', targetSessionRef='target',
                           attempt=2, nextAttemptInMs=1800000))
        self.assertEqual(memos.birth['target']['kind'], 'not_hosted')

    def test_unknown_log_events_tolerate_null_event_or_data(self):
        memos = Memos()
        memos.accept(event('mail_injector.started'))
        before = memos.signature()
        for row in (dict(event=None, data={}), dict(event='future.event', data=None),
                    dict(event='future.event', data=[])):
            memos.accept(row)
        self.assertEqual(memos.signature(), before)

    def test_missing_or_null_notice_fields_remain_unknown(self):
        memos = Memos()
        memos.accept(event('mail_injector.started'))
        for fields in ({}, dict(envelopes=None, attempt=None, nextAttemptInMs=None)):
            memos.accept(event('wrkq.kicker.failure_notice_failed', targetSessionRef='target', **fields))
            self.assertIsNone(memos.notices['target']['envelopes'])
            self.assertIsNone(memos.notices['target']['attempts'])
            self.assertIsNone(memos.notices['target']['delay'])

    def test_broker_movement_with_known_boundary_does_not_require_time(self):
        memos = Memos()
        memos.accept(event('mail_injector.started'))
        memos.accept(event('wrkq.kicker.steer_held', runtimeId='rt',
            hold='pane_not_quiescent', invocationId='inv', brokerSeq=4))
        for timestamp in (None, 'missing'):
            with self.subTest(timestamp=timestamp):
                memos.quiet['rt'] = dict(since=None, invocation='inv', seq=4)
                record = dict(type='tool.started', seq=5, invocationId='inv')
                if timestamp is None:
                    record['time'] = None
                memos.broker('rt', record)
                self.assertNotIn('rt', memos.quiet)
