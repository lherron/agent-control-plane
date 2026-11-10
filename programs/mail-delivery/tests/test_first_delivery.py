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

    def test_watch_history_uses_idle_status_before_own_delivery_changed_it(self):
        from mail_delivery.shadow import WatchHistory
        h=WatchHistory()
        h.record('seat',dict(scopeRef=TARGET,activeRuntimeId='rt-1',node='max3'),ms('2026-11-10T12:00:00Z'))
        h.record('runtime',dict(runtimeId='rt-1',status='ready'),ms('2026-11-10T12:00:00Z'))
        h.record('runtime',dict(runtimeId='rt-1',status='busy'),ms('2026-11-10T12:00:02Z'))
        original=self.port.hrc.runtimes
        self.port.hrc.runtimes=lambda **p:[dict(r,status='busy',statusChangedAt='2026-11-10T12:00:02Z') for r in original(**p)]
        e,s,r,_=self.port.gather(self.mail,self.detail,self.store,self.now)
        value=self.port.first_delivery(self.mail,self.detail,self.store,e,s,r,self.now,history=h)
        self.assertEqual(value['decision']['action'],'steer')
        self.assertEqual(value['inputs']['runtime']['status'],'ready')
        self.assertEqual(value['history']['runtime']['received_at'],ms('2026-11-10T12:00:00Z'))

    def test_admission_reconstruction_uses_retained_reads_without_new_hrc_calls(self):
        from mail_delivery.shadow import WatchHistory
        h=WatchHistory()
        h.record('seat',dict(scopeRef=TARGET,activeRuntimeId='rt-1',node='max3'),ms('2026-11-10T12:00:00Z'))
        h.record('runtime',dict(runtimeId='rt-1',status='ready'),ms('2026-11-10T12:00:00Z'))
        self.port.gather(self.mail,self.detail,self.store,self.now)
        self.port.begin()
        before=list(self.calls)
        admission=self.memos.deliveries.first_admission('EN-1')
        value=self.port.first_from_intent(dict(self.mail,state='acked'),dict(self.detail,state='acked'),self.store,admission,h,self.now)
        self.assertEqual(self.calls,before)
        self.assertEqual(value['decision']['action'],'steer')
        self.assertEqual(value['history']['runtime']['received_at'],ms('2026-11-10T12:00:00Z'))

    def test_missing_pre_admission_watch_history_is_named(self):
        from mail_delivery.shadow import WatchHistory
        e,s,r,_=self.port.gather(self.mail,self.detail,self.store,self.now)
        value=self.port.first_delivery(self.mail,self.detail,self.store,e,s,r,self.now,history=WatchHistory())
        self.assertEqual(value['decision']['action'],'cannot_decide')
        self.assertIn('history_cold',value['missing_fields'])

    def test_later_intent_row_cannot_prove_first_invocation_capability(self):
        self.store['intent']['submitted_at']='2026-11-10T12:00:02Z'
        value=self.reconstruct()
        self.assertEqual(value['capability_source'],'injector_log')

    def test_proven_status_change_received_late_is_reported_as_watch_lag(self):
        from mail_delivery.shadow import WatchHistory
        h=WatchHistory()
        h.record('seat',dict(scopeRef=TARGET,activeRuntimeId='rt-1'),ms('2026-11-10T12:00:00Z'))
        h.record('runtime',dict(runtimeId='rt-1',status='awaiting_input',statusChangedAt='2026-11-10T11:59:59Z'),ms('2026-11-10T12:00:00Z'))
        h.record('runtime',dict(runtimeId='rt-1',status='ready',statusChangedAt='2026-11-10T12:00:00.500Z'),ms('2026-11-10T12:00:02Z'))
        e,s,r,_=self.port.gather(self.mail,self.detail,self.store,self.now)
        value=self.port.first_delivery(self.mail,self.detail,self.store,e,s,r,self.now,history=h)
        self.assertIn('first_delivery.runtime_watch_lag',value['missing_fields'])
        self.assertEqual(value['history_status_lag_ms'],1500)

    def test_cold_home_uses_existing_get_and_labels_after_admission_with_proof(self):
        from mail_delivery.shadow import WatchHistory
        h=WatchHistory();at=ms('2026-11-10T12:00:00Z')
        h.record('seat',dict(scopeRef=TARGET,activeRuntimeId='rt-1'),at)
        h.record('runtime',dict(runtimeId='rt-1',status='ready'),at)
        admission=self.memos.deliveries.first_admission('EN-1')
        value=self.port.first_from_intent(self.mail,self.detail,self.store,admission,h,self.now)
        self.assertEqual(self.calls,['/v1/federation/locate','/v1/runtimes/rt-1/seat'])
        self.assertEqual(value['home_source'],'read_after_admission')
        self.assertTrue(value['home_binding_predates_admission'])
        self.assertNotIn('first_delivery.home_at_admission',value['missing_fields'])

    def test_cached_home_before_admission_keeps_source_and_does_not_read_again(self):
        from mail_delivery.shadow import WatchHistory
        self.port.gather(self.mail,self.detail,self.store,self.now)
        key=('/v1/federation/locate',(('scopeRef',TARGET),))
        self.port.cache_read_at[key]=ms('2026-11-10T12:00:00Z')
        h=WatchHistory();h.record('seat',dict(scopeRef=TARGET,activeRuntimeId='rt-1'),ms('2026-11-10T12:00:00Z'))
        h.record('runtime',dict(runtimeId='rt-1',status='ready'),ms('2026-11-10T12:00:00Z'))
        before=list(self.calls)
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertEqual(self.calls,before)
        self.assertEqual(value['home_source'],'cached_before_admission')
        self.assertEqual(value['decision']['action'],'steer')

    def test_ready_watch_with_no_scope_proves_absence_and_launch(self):
        from mail_delivery.shadow import WatchHistory
        h=WatchHistory();h.ready_at['seat']=ms('2026-11-10T11:59:00Z')
        self.store['diagnostic']['observed_seat_state']='absent'
        self.intent['data'].update(door='launch',runtimeId=None,observedSeatState='absent')
        self.memos.deliveries.intents['EN-1'][0]['row']['data'].update(door='launch',runtimeId=None,observedSeatState='absent')
        admission=dict(self.memos.deliveries.first_admission('EN-1') or {},at=self.intent['ts'],runtime_id='rt-born',admitted_at='2026-11-10T12:00:02Z',intent=self.intent,memo=self.memos.deliveries.intents['EN-1'][0]['memo'])
        value=self.port.first_from_intent(self.mail,dict(self.detail,delivery='hold'),dict(self.store,intent=None),admission,h,self.now)
        self.assertEqual(value['decision']['action'],'launch')
        self.assertEqual(value['seat_state_source'],'watch_absence')
        self.assertFalse(value['inputs']['seat']['session_exists'])
        self.assertNotIn('first_delivery.preempt_admission_at_admission',value['missing_fields'])

    def test_history_cold_is_named_and_reconstruction_never_calls_preempt_admission(self):
        from mail_delivery.shadow import WatchHistory
        self.port.hrc.post=lambda *a,**kw: self.fail('reconstruction must not POST')
        admission=self.memos.deliveries.first_admission('EN-1')
        value=self.port.first_from_intent(self.mail,dict(self.detail,delivery='hold'),self.store,admission,WatchHistory(),self.now)
        self.assertIn('history_cold',value['missing_fields'])
        self.assertIn('first_delivery.preempt_admission_at_admission',value['missing_fields'])
        self.assertEqual(self.calls,['/v1/federation/locate','/v1/runtimes/rt-1/seat'])

    def test_unready_absent_scope_reports_history_cold_as_the_root_gap(self):
        from mail_delivery.shadow import WatchHistory
        self.store['diagnostic']['observed_seat_state']='absent'
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),WatchHistory(),self.now)
        self.assertEqual(value['missing_fields'],['history_cold'])

    def late_probe_setup(self, *, history_invocation='inv', probe_invocation='inv', generation=2, events=None):
        from mail_delivery.shadow import WatchHistory
        h=WatchHistory();at=ms('2026-11-10T12:00:00Z')
        payload=dict(runtimeId='rt-1',status='ready',generation=2)
        if history_invocation is not None:payload['activeInvocationId']=history_invocation
        h.record('seat',dict(scopeRef=TARGET,activeRuntimeId='rt-1'),at)
        h.record('runtime',payload,at)
        self.store['intent']=None
        self.memos.deliveries.intents['EN-1'][0]['row']['data'].pop('steerCapable',None)
        old=self.port.hrc.get
        def get(route,**params):
            if route=='/v1/broker-events':
                self.calls.append(route)
                self.assertEqual(params['afterSeq'],0)
                self.assertEqual(params['follow'],'false')
                self.assertNotIn('consumer',params)
                return events or []
            value=old(route,**params)
            if route=='/v1/runtimes/rt-1/seat':
                value=dict(value,runtimeId='rt-1',invocationId=probe_invocation,generation=generation)
            return value
        self.port.hrc.get=get
        return h

    def test_late_probe_uses_asof_invocation_and_generation_without_broker_replay(self):
        h=self.late_probe_setup()
        value=self.port.first_from_intent(self.mail,dict(self.detail,state='acked'),self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertEqual(value['decision']['action'],'steer')
        self.assertEqual(value['capability_source'],'port_probe_after_admission')
        self.assertEqual(value['capability_proof']['source'],'runtime_history')
        self.assertNotIn('/v1/broker-events',self.calls)

    def test_late_probe_cold_invocation_is_proven_by_anonymous_broker_record(self):
        h=self.late_probe_setup(history_invocation=None,events=[dict(invocationId='inv',seq=1,time='2026-11-10T11:00:00Z')])
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertEqual(value['decision']['action'],'steer')
        self.assertEqual(value['capability_source'],'port_probe_after_admission')
        self.assertEqual(value['capability_proof']['seq'],1)
        self.assertEqual(value['capability_proof']['time'],'2026-11-10T11:00:00Z')

    def test_late_probe_rejects_same_runtime_generation_with_a_different_invocation(self):
        h=self.late_probe_setup(probe_invocation='inv-replacement',events=[dict(invocationId='inv-replacement',seq=1,time='2026-11-10T11:00:00Z')])
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertEqual(value['decision']['action'],'cannot_decide')
        self.assertIn('first_delivery.invocation_at_admission',value['missing_fields'])

    def test_late_probe_rejects_replaced_generation(self):
        h=self.late_probe_setup(generation=3)
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertEqual(value['decision']['action'],'cannot_decide')
        self.assertIn('first_delivery.runtime_replaced',value['missing_fields'])

    def test_late_probe_without_an_earlier_broker_record_keeps_named_gap(self):
        for rows in ([],[dict(invocationId='inv',seq=1,time='2026-11-10T12:00:02Z')],
                     [dict(invocationId='other',seq=1,time='2026-11-10T11:00:00Z')]):
            with self.subTest(rows=rows):
                self.setUp();h=self.late_probe_setup(history_invocation=None,events=rows)
                value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
                self.assertIn('first_delivery.invocation_at_admission',value['missing_fields'])
                self.assertEqual(value['decision']['action'],'cannot_decide')

    def test_late_probe_prefers_an_ordinary_read_from_before_admission(self):
        h=self.late_probe_setup(history_invocation=None)
        key=('runtimes','hsid-1')
        self.port.cache[key]=[dict(runtimeId='rt-1',generation=2,activeInvocationId='inv')]
        self.port.cache_read_at[key]=ms('2026-11-10T12:00:00Z')
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertEqual(value['decision']['action'],'steer')
        self.assertEqual(value['capability_proof']['source'],'ordinary_read')
        self.assertNotIn('/v1/broker-events',self.calls)

    def test_late_probe_null_classes_are_unknown_instead_of_a_historical_false(self):
        h=self.late_probe_setup()
        old=self.port.hrc.get
        self.port.hrc.get=lambda route,**params: dict(old(route,**params),admissionClasses=None) if route.endswith('/seat') else old(route,**params)
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertIn('first_delivery.steer_capable',value['missing_fields'])
        self.assertEqual(value['decision']['action'],'cannot_decide')

    def test_anonymous_broker_retention_refusal_is_a_named_proof_gap(self):
        from mail_delivery.hrc_read import HrcError
        h=self.late_probe_setup(history_invocation=None)
        old=self.port.hrc.get
        def get(route,**params):
            if route=='/v1/broker-events':raise HrcError(409,{'error':{'code':'cursor_expired'}})
            return old(route,**params)
        self.port.hrc.get=get
        value=self.port.first_from_intent(self.mail,self.detail,self.store,self.memos.deliveries.first_admission('EN-1'),h,self.now)
        self.assertIn('first_delivery.invocation_at_admission',value['missing_fields'])
        self.assertEqual(value['capability_proof']['poll_error']['code'],'cursor_expired')
