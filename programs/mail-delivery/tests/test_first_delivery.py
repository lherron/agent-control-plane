from dataclasses import asdict
from unittest import TestCase
from mail_delivery.memos import Memos
from mail_delivery.port_inputs import PortInputs, ms
from tests.test_port_inputs import Hrc, TARGET


class FirstDelivery(TestCase):
    def setUp(self):
        self.memos = Memos()
        self.memos.accept(dict(event='mail_injector.started', ts='2026-11-10T11:00:00Z'))
        self.calls = []
        hrc = Hrc()
        original = hrc.get
        def get(route, **params):
            self.calls.append(route)
            value = original(route, **params)
            if route == '/v1/federation/locate':
                value['authority']['record'] = {'updatedAt': '2026-11-10T11:00:00Z'}
            return value
        hrc.get = get
        runtimes = hrc.runtimes
        hrc.runtimes = lambda **params: [dict(r, statusChangedAt='2026-11-10T11:00:00Z') for r in runtimes(**params)]
        self.port = PortInputs(hrc, self.memos)
        self.mail = dict(id='EN-1', state='pending', obligation='reply_required',
            createdAt='2026-11-10T12:00:00Z', to={'scopeRef': TARGET})
        self.detail = dict(self.mail, delivery='queue', presentedTo=[])
        self.store = dict(intent={'door': 'steer', 'runtime_id': 'rt-1', 'invocation_id': 'inv',
                'submitted_at': '2026-11-10T12:00:01Z'}, presentations=[], expiries=[],
            launch=None, birth=None, notices=[], diagnostic=dict(outcome='admitted',
                runtime_id='rt-1', observed_seat_state='turn-active', created_at='2026-11-10T12:00:02Z'))
        self.intent = dict(event='wrkq.kicker.delivery_intent', ts='2026-11-10T12:00:01Z', data=dict(
            envelope='EN-1', targetSessionRef=TARGET+'/lane:main', door='steer',
            form='full', runtimeId='rt-1', steerCapable=True))
        self.memos.accept(self.intent)
        self.memos.accept(dict(event='wrkq.kicker.delivery_admitted', ts='2026-11-10T12:00:02Z',
            data=dict(envelope='EN-1', runtimeId='rt-1', door='steer')))
        self.now = ms('2026-11-10T12:00:03Z')

    def reconstruct(self):
        envelope, seat, runtime, _ = self.port.gather(self.mail, self.detail, self.store, self.now)
        before = list(self.calls)
        value = self.port.first_delivery(self.mail, self.detail, self.store, envelope, seat, runtime, self.now)
        self.assertEqual(self.calls, before, 'reconstruction must perform no HRC/owner reads')
        return value

    def test_own_matching_probe_is_preferred_and_own_intent_is_removed(self):
        value = self.reconstruct()
        self.assertEqual(value['decision']['action'], 'steer')
        self.assertEqual(value['capability_source'], 'port_probe')
        self.assertEqual(value['inputs']['envelope']['intent']['status'], 'none')
        self.assertEqual(value['inputs']['seat']['state'], 'turn-active')
        self.assertEqual(value['at'], '2026-11-10T12:00:01Z')

    def test_capability_derivation_disagreement_is_retained(self):
        self.memos.deliveries.intents['EN-1'][0]['row']['data']['steerCapable'] = False
        value = self.reconstruct()
        self.assertEqual(value['capability_source'], 'port_probe')
        self.assertTrue(value['capability_differed'])
        self.assertEqual(value['decision']['action'], 'steer')

    def test_logged_capability_is_labelled_fallback_without_matching_invocation(self):
        self.store['intent']['invocation_id'] = 'some-other-invocation'
        value = self.reconstruct()
        self.assertEqual(value['capability_source'], 'injector_log')
        self.assertEqual(value['decision']['action'], 'steer')

    def test_later_runtime_status_is_named_unknown_not_assumed(self):
        original = self.port.hrc.runtimes
        self.port.hrc.runtimes = lambda **params: [dict(r, statusChangedAt='2026-11-10T12:00:02Z') for r in original(**params)]
        value = self.reconstruct()
        self.assertEqual(value['decision']['action'], 'cannot_decide')
        self.assertIn('first_delivery.runtime_status_at_admission', value['missing_fields'])

    def test_missing_capability_and_historical_hold_authority_are_named(self):
        self.store['intent']['invocation_id'] = 'unmatched'
        self.memos.deliveries.intents['EN-1'][0]['row']['data'].pop('steerCapable')
        value = self.reconstruct()
        self.assertEqual(value['decision']['action'], 'cannot_decide')
        self.assertIn('first_delivery.steer_capable', value['missing_fields'])

    def test_historical_memo_is_not_the_own_outcome_that_happened_later(self):
        self.memos.capability.add('rt-1')
        self.memos.fallback['EN-1'] = 'capability'
        value = self.reconstruct()
        self.assertEqual(value['decision']['action'], 'steer')
        self.assertFalse(value['inputs']['seat']['steer_capability_refused'])

    def test_existing_runtime_probe_history_proves_invocation_after_intent_row_is_gone(self):
        self.store['intent'] = None
        original = self.port.hrc.runtimes
        self.port.hrc.runtimes = lambda **params: [dict(r, runtimeStateJson=dict(
            brokerDispatchDiagnostics=dict(liveSeatProbe=dict(invocationId='inv', observedAt='2026-11-10T11:00:00Z'))))
            for r in original(**params)]
        value = self.reconstruct()
        self.assertEqual(value['capability_source'], 'port_probe')
        self.assertEqual(value['decision']['action'], 'steer')
