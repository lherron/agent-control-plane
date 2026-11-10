from unittest import TestCase
from mail_delivery.shadow import WatchHistory


class History(TestCase):
    def test_as_of_keeps_pre_delivery_status_and_both_clocks(self):
        h = WatchHistory()
        h.record('runtime', dict(runtimeId='rt', status='idle', statusChangedAt='2026-11-10T12:00:00Z'), 1794312000100)
        h.record('runtime', dict(runtimeId='rt', status='busy', statusChangedAt='2026-11-10T12:00:02Z'), 1794312002200)
        before = h.as_of('runtime', 'rt', 1794312001000)
        self.assertEqual(before['payload']['status'], 'idle')
        self.assertEqual(before['received_at'], 1794312000100)
        self.assertEqual(before['changed_at'], 1794312000000)

    def test_late_or_future_payload_is_not_historical_proof(self):
        h = WatchHistory()
        h.record('runtime', dict(runtimeId='rt', statusChangedAt='2026-11-10T12:00:00Z'), 1794312002000)
        self.assertIsNone(h.as_of('runtime', 'rt', 1794312001000))
        h.record('seat', dict(scopeRef='scope', lastActivityAt='2026-11-10T12:00:03Z'), 1794312001000)
        self.assertIsNone(h.as_of('seat', 'scope', 1794312002000))

    def test_bound_copy_and_duplicate_observation_preserve_first_receipt(self):
        h = WatchHistory(limit=2)
        p = dict(runtimeId='rt', status='idle')
        h.record('runtime', p, 100)
        h.record('runtime', p, 200)
        p['status'] = 'busy'
        self.assertEqual(h.as_of('runtime','rt',150)['payload']['status'], 'idle')
        h.record('runtime', p, 300)
        h.record('runtime', dict(p,status='stopped'), 400)
        self.assertEqual(len(h.rows['runtime']['rt']), 2)
        self.assertIsNone(h.as_of('runtime','rt',250))

    def test_remove_and_reset_do_not_reuse_a_deleted_current_row(self):
        from mail_delivery.shadow import Shadow
        from tests.test_shadow import Client, Inputs, change, row
        s=Shadow(Client(),Inputs(),lambda rows:{})
        s.apply('runtime',change(row('node',runtimeId='rt',status='ready'),reset=True),received_at=100)
        s.apply('runtime',change(remove=('node',)),received_at=200)
        self.assertEqual(s.history.as_of('runtime','rt',150)['payload']['status'],'ready')
        self.assertIsNone(s.history.as_of('runtime','rt',250))
