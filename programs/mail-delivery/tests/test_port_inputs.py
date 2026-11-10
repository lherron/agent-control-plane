from dataclasses import replace
from unittest import TestCase
from mail_delivery.port_inputs import PortInputs
from mail_delivery.decision import decide
from mail_delivery.memos import Memos
from mail_delivery.hrc_read import HrcError


TARGET = 'agent:cody:project:agent-control-plane:task:T-13270'


class Hrc:
    """Shapes paired with max3 live reads in live-input-shapes.json."""
    def get(self, route, **params):
        if route == '/v1/federation/locate':
            return {'localNodeId': 'max3', 'authority': {'state': 'bound', 'isLocal': True}}
        if route == '/v1/targets/by-session-ref':
            return {'activeHostSessionId': 'hsid-1'}
        if route == '/v1/sessions/by-host/hsid-1':
            return {'hostSessionId': 'hsid-1', 'generation': 2}
        if route == '/v1/runtimes/rt-1/seat':
            return {'invocationId': 'inv', 'generation': 2, 'currentBrokerSeq': 4,
                    'admissionClasses': ['steer', 'queue'],
                    'probe': {'seat': {'state': 'turn-active'}}}
        if route == '/v1/broker-events':
            return []
        if route == '/v1/events/tail':
            return {'events': []}
        raise AssertionError((route, params))

    def runtimes(self, **params):
        return [dict(runtimeId='rt-old', generation=1, status='ready', controllerKind='harness-broker',
                     activeInvocationId='inv-old'),
                dict(runtimeId='rt-1', generation=2, status='busy', controllerKind='harness-broker',
                     activeInvocationId='inv', createdAt='2026-11-10T11:00:00Z')]


class PortAdapter(TestCase):
    def setUp(self):
        self.memos = Memos()
        self.memos.accept(dict(ts='2026-11-10T11:00:00Z', event='mail_injector.started'))
        self.port = PortInputs(Hrc(), self.memos)
        self.mail = dict(id='EN-1', state='pending', obligation='reply_required',
                         createdAt='2026-11-10T12:00:00Z', to={'scopeRef': TARGET})
        self.detail = dict(self.mail, presentedTo=[], delivery='queue')
        self.store = dict(intent=None, presentations=[], expiry=None, birth=None, launch=None,
                          notices=[])

    def test_live_seat_probe_and_confirmed_empty_store_choose_steer(self):
        e, s, r, tags = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertEqual(s.state, 'turn-active')
        self.assertEqual(r.id, 'rt-1')
        self.assertEqual(decide(e, s, r, 1794312001000).action, 'steer')
        self.assertIn('injector_outcomes', tags['log_fed_memos'])

    def test_unanchored_log_is_a_named_feeder_gap(self):
        self.memos.reset()
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        d = decide(e, s, r, 1794312001000)
        self.assertEqual(d.action, 'cannot_decide')
        self.assertEqual(d.missing_fact, 'envelope.birth_retry')

    def test_all_hrc_terminal_statuses_are_excluded_from_seat_selection(self):
        for status in ('terminated', 'crashed', 'dead', 'stale', 'stopped', 'failed', 'disposed', 'exited'):
            with self.subTest(status=status):
                self.port.begin()
                self.port.hrc.runtimes = lambda **kw: [dict(runtimeId='rt-1', generation=2,
                    status=status, controllerKind='harness-broker', activeInvocationId='inv')]
                original = Hrc().get
                self.port.hrc.get = lambda route, **kw: (
                    {'localNodeId': 'max3', 'nodes': [dict(state='answered', nodeId='max3', runtimes=[])]}
                    if route == '/v1/federation/runtimes' else original(route, **kw))
                _, seat, _, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
                self.assertEqual(seat.state, 'absent')

    def test_launch_exhaustion_precedes_process_local_backoff(self):
        self.store['launch'] = dict(attempts=3, participant_host_since_ms=None)
        self.memos.birth[TARGET+'/lane:main'] = dict(kind='sweep', attempts=1,
                at=1794312000000, delay=60000, reason=None)
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertEqual(decide(e, s, r, 1794312001000).action, 'fail')

    def test_injector_restart_forgets_pacing_but_keeps_unexhausted_participant_clock(self):
        self.store['launch'] = dict(attempts=8, participant_host_since_ms=1794312000000)
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertEqual(decide(e, s, r, 1794312001000).action, 'steer')

    def test_hold_uses_exact_read_route_with_required_body_and_origin(self):
        self.detail.update(delivery='hold', body='A real envelope body',
                           **{'from': {'principalRef': 'agent:mable'}})
        def post(route, **request):
            self.assertEqual(route, '/v1/submissions/preempt/admission')
            self.assertTrue(request['body'])
            self.assertEqual(request['origin']['envelopeId'], 'EN-1')
            return {'admission': 'authorized'}
        self.port.hrc.post = post
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertEqual(decide(e, s, r, 1794312001000).action, 'preempt')

    def test_intent_is_not_replaced_with_injector_diagnostic_door(self):
        self.store['intent'] = dict(door='enqueue', submitted_at='2026-11-10T12:00:00Z',
            runtime_id='rt-1', uncertain_cause=None, last_evidence_kind=None,
            cleanup_at=None, terminal_envelope_cause=None, submission_id='sub-1')
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertEqual(decide(e, s, r, 1794312001000).reason, 'intent_open')

    def test_fenced_mail_does_not_pay_for_before_birth_federation_inventory(self):
        self.port.hrc.runtimes = lambda **kw: []
        self.store['intent'] = dict(door='enqueue', submitted_at='2026-11-10T12:00:00Z', runtime_id='rt-1')
        # Hrc.get deliberately has no federation/runtimes stub. Like the
        # injector's empty-actionable early exit, this must not request it.
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertEqual(decide(e, s, r, 1794312001000).reason, 'intent_open')

    def test_presented_receipt_and_durable_operator_hold(self):
        self.mail['state'] = 'presented'
        self.detail['presentedTo'] = [dict(runtimeId='rt-1', presentedAt='2026-11-10T12:00:00Z')]
        self.store['presentations'] = [dict(runtime_id='rt-1', landing_hrc_seq=8,
            disposition='held:awaiting_operator', reminder_armed_at=None,
            reminder_landing_hrc_seq=None, reminder_due_at=None)]
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertEqual(decide(e, s, r, 1794312001000).reason, 'awaiting_operator')

    def test_disposed_presentation_cannot_arm_reminder_from_lagging_document(self):
        # EN-50794 on max3: wrkq acked at 19:52:05, injector persisted
        # skipped:not_presented:acked at 19:52:11 while document still presented.
        self.mail['state'] = 'presented'
        self.detail['presentedTo'] = [dict(runtimeId='rt-1', presentedAt='2026-11-10T12:00:00Z')]
        self.store['presentations'] = [dict(runtime_id='rt-1', landing_hrc_seq=8,
            disposed_at='2026-11-10T12:00:01Z', disposition='skipped:not_presented:acked')]
        original = self.port.hrc.get
        self.port.hrc.get = lambda route, **params: (
            {'events': [dict(hrcSeq=9, ts='2026-11-10T12:00:01Z')]}
            if route == '/v1/events/tail' else original(route, **params))
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312002000)
        self.assertEqual(decide(e, s, r, 1794312002000).reason, 'no_due_reminder')

    def test_unknown_session_means_no_session_as_in_socket_injection_port(self):
        original = self.port.hrc.get
        def get(route, **params):
            if route == '/v1/targets/by-session-ref':
                raise HrcError(404, {'error': {'code': 'unknown_session'}})
            if route == '/v1/federation/runtimes':
                return {'localNodeId': 'max3', 'nodes': [dict(state='answered', nodeId='max3', runtimes=[])]}
            return original(route, **params)
        self.port.hrc.get = get
        e, s, r, _ = self.port.gather(self.mail, self.detail, self.store, 1794312001000)
        self.assertFalse(s.session_exists)
        self.assertEqual(decide(e, s, r, 1794312001000).action, 'launch')
