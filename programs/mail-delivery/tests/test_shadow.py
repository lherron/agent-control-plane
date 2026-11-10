"""View and dedup contracts, written before the live loop (T-13270)."""
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from mail_delivery.shadow import View, Shadow, ContextClient
from mail_delivery.decision import Envelope, Seat, Runtime


TARGET = 'agent:cody:project:agent-control-plane:task:T-13270'


def row(identifier, **payload):
    return dict(id=identifier, payload=payload)


def change(*rows, reset=False, remove=()):
    return SimpleNamespace(reset=reset, rows=rows if reset else (),
                           upsert=() if reset else rows, remove=remove)


class Views(TestCase):
    def test_every_program_log_includes_pid_and_config_socket(self):
        client = Client()
        contextual = ContextClient(client, {'socket': '/tmp/test.sock'})
        contextual.log('shadow.started', count=1)
        data = client.logs[0][1]
        self.assertEqual(data['kernel_socket'], '/tmp/test.sock')
        self.assertGreater(data['pid'], 0)

    def test_reset_replaces_and_diff_upserts_and_removes_by_node_id(self):
        view = View()
        view.apply(change(row('a', id='EN-1'), row('b', id='EN-2'), reset=True))
        view.apply(change(row('a', id='EN-1', state='presented'), remove=('b',)))
        self.assertEqual(view.rows, {'a': row('a', id='EN-1', state='presented')})
        view.apply(change(row('c', id='EN-3'), reset=True))
        self.assertEqual(set(view.rows), {'c'})
        view.apply(change(reset=True))
        self.assertEqual(view.rows, {})


class Client:
    def __init__(self):
        self.calls = []
        self.logs = []

    def read(self, op, **args):
        self.calls.append((op, args))
        if op == 'room.mail.get':
            return {'ok': True, 'result': dict(id=args['envelope'], state='pending',
                    delivery='queue', presentedTo=[], createdAt='2026-11-10T12:00:00Z')}
        if op == 'seat.get':
            return {'ok': True, 'result': row('seat-1', scopeRef=TARGET,
                                             status='active', node='max3')}
        raise AssertionError(op)

    def log(self, event, **data):
        self.logs.append((event, data))


class Inputs:
    def begin(self):
        pass

    def gather(self, mail, detail, store, now):
        return (Envelope(id=mail['id'], state=mail['state']), Seat(), Runtime(), {})


class Dedup(TestCase):
    def setUp(self):
        self.client = Client()
        self.shadow = Shadow(self.client, Inputs(), lambda mail: {m['id']: {} for m in mail})
        self.mail = row('mail-1', id='EN-1', state='pending',
                        obligation='reply_required', createdAt='2026-11-10T12:00:00Z',
                        to={'scopeRef': TARGET})
        self.shadow.apply('seat', change(row('seat-1', scopeRef=TARGET,
                          status='active', activeRuntimeId='rt-1'), reset=True))
        self.shadow.apply('runtime', change(row('runtime-1', runtimeId='rt-1',
                          status='busy'), reset=True))
        self.shadow.apply('room.mail', change(self.mail, reset=True))

    def sweep(self):
        self.shadow.sweep(1794312001000)

    def decisions(self):
        return [data for event, data in self.client.logs if event == 'shadow.decision']

    def test_wait_for_all_initial_snapshots(self):
        shadow = Shadow(self.client, Inputs(), lambda mail: {})
        shadow.apply('room.mail', change(self.mail, reset=True))
        shadow.sweep(1794312001000)
        self.assertEqual(self.decisions(), [])
        self.assertEqual(self.client.calls, [])

    def test_scope_less_mail_belongs_to_interface_delivery_not_seat_injector(self):
        human = row('human-mail', id='EN-2', state='pending',
                    to={'principalRef': 'human:lance'})
        self.shadow.apply('room.mail', change(human, reset=True))
        self.sweep()
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.decisions(), [])

    def test_decision_timestamp_is_after_input_collection(self):
        self.shadow.sweep(1794312001000, clock=lambda: 1794312003000)
        self.assertEqual(self.decisions()[0]['decided_at'], '2026-11-10T12:00:03.000Z')

    def test_bounded_batch_yields_to_watch_then_resumes_without_forgetting_mail(self):
        other = row('mail-2', **dict(self.mail['payload'], id='EN-2'))
        self.shadow.apply('room.mail', change(other))
        with patch('mail_delivery.shadow.time.monotonic', side_effect=[0, 0, 3]):
            self.shadow.sweep(1794312001000, budget_seconds=2)
        self.assertEqual(len(self.decisions()), 1)
        with patch('mail_delivery.shadow.time.monotonic', return_value=0):
            self.shadow.sweep(1794312001000, budget_seconds=2)
        self.assertEqual(len(self.decisions()), 2)

    def test_timeout_duplicate_reset_and_unrelated_updates_do_not_redecide(self):
        self.sweep()
        calls = list(self.client.calls)
        self.sweep()
        self.shadow.apply('room.mail', change(self.mail, reset=True))
        self.shadow.apply('seat', change(row('other', scopeRef='other', status='inactive')))
        self.sweep()
        self.assertEqual(len(self.decisions()), 1)
        self.assertEqual(self.client.calls, calls)
        self.assertEqual(self.decisions()[0]['decision']['missing_fact'], 'seat.home')
        self.assertEqual(self.decisions()[0]['missing_fields'], ['seat.home'])
        self.assertIsNone(self.decisions()[0]['observed_seat_state'])
        self.assertEqual(self.decisions()[0]['seat_summary_state'], 'active')

    def test_seat_state_change_redecides_without_owner_reads(self):
        self.sweep()
        calls = list(self.client.calls)
        self.shadow.apply('seat', change(row('seat-1', scopeRef=TARGET, status='inactive')))
        self.sweep()
        self.assertEqual(len(self.decisions()), 2)
        self.assertEqual(self.client.calls, calls)

    def test_envelope_state_change_reads_owner_once_and_removed_mail_is_forgotten(self):
        self.sweep()
        self.mail['payload']['state'] = 'presented'
        self.shadow.apply('room.mail', change(self.mail))
        self.sweep()
        self.sweep()
        self.assertEqual(len(self.decisions()), 2)
        self.assertEqual(sum(op == 'room.mail.get' for op, _ in self.client.calls), 2)
        self.shadow.apply('room.mail', change(remove=('mail-1',)))
        self.sweep()
        self.assertEqual(self.shadow.last, {})
        self.assertEqual(self.shadow.details, {})

    def test_new_receipt_in_same_presented_state_refreshes_owner_detail(self):
        self.mail['payload'].update(state='presented', presentedAt='2026-11-10T12:00:01Z')
        self.shadow.apply('room.mail', change(self.mail))
        self.sweep()
        self.mail['payload']['presentedAt'] = '2026-11-10T12:00:03Z'
        self.shadow.apply('room.mail', change(self.mail))
        self.sweep()
        self.assertEqual(len(self.client.calls), 2)

    def test_do_not_infer_placement_or_broker_state_from_summary_or_node(self):
        self.sweep()
        observed = self.decisions()[0]
        self.assertEqual(observed['decision']['action'], 'cannot_decide')
        self.assertEqual(observed['target'], TARGET)
        self.assertEqual(self.client.calls[0], ('room.mail.get', {'envelope': 'EN-1'}))
        self.assertEqual(observed['appeared_at'], '2026-11-10T12:00:00Z')

    def test_envelope_payload_change_redecides_but_does_not_repeat_owner_read(self):
        self.sweep()
        self.mail['payload']['obligation'] = 'notify'
        self.shadow.apply('room.mail', change(self.mail))
        self.sweep()
        self.assertEqual(len(self.decisions()), 2)
        self.assertEqual(len(self.client.calls), 1)

    def test_one_envelope_exception_is_logged_and_next_envelope_is_decided(self):
        other = row('mail-2', **dict(self.mail['payload'], id='EN-2'))
        self.shadow.apply('room.mail', change(other))
        original = self.shadow.source.gather
        def gather(mail, *args):
            if mail['id'] == 'EN-1':
                raise TypeError('null admission classes')
            return original(mail, *args)
        self.shadow.source.gather = gather
        self.sweep()
        self.assertEqual([d['envelope_id'] for d in self.decisions()], ['EN-2'])
        failures = [data for name, data in self.client.logs if name == 'shadow.decision_failed']
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]['envelope_id'], 'EN-1')
        self.assertEqual(failures[0]['target'], TARGET)
        self.assertEqual(failures[0]['exception_type'], 'TypeError')
        self.assertEqual(failures[0]['message'], 'null admission classes')
        self.assertIn('Traceback', failures[0]['traceback'])
        self.assertNotIn('EN-1', self.shadow.last)

    def test_intent_completion_refreshes_pending_owner_detail_before_another_decision(self):
        # EN-50847: owner detail was pending before landing at21:04:09.587;
        # the next local snapshot lost its intent while the watch still said
        # pending. Reusing that detail would suggest another full steer.
        snapshot = {'intent': {'submitted_at': '2026-11-10T12:00:00Z'}, 'presentations': []}
        self.shadow.store = lambda rows: {'EN-1': dict(snapshot)}
        states = iter(('pending', 'presented'))
        original_read = self.client.read
        def read(op, **args):
            result = original_read(op, **args)
            if op == 'room.mail.get':
                result['result']['state'] = next(states)
            return result
        self.client.read = read
        def gather(mail, detail, store, now):
            return Envelope(id=mail['id'], state=detail['state']), Seat(), Runtime(), {}
        self.shadow.source.gather = gather
        self.sweep()
        snapshot.update(intent=None, presentations=[{'runtime_id': 'rt-1', 'landing_hrc_seq': 8}])
        self.shadow.sweep(1794312002000, force=True)
        self.assertEqual(len(self.client.calls), 2)
        self.assertEqual([d['envelope_state'] for d in self.decisions()], ['pending', 'presented'])

    def test_admission_trigger_compares_already_acked_mail_without_open_sweep(self):
        from mail_delivery.memos import Memos
        from mail_delivery.port_inputs import ms
        memos=Memos()
        memos.accept(dict(event='mail_injector.started',ts='2026-11-10T11:00:00Z'))
        memos.accept(dict(event='wrkq.kicker.delivery_intent',ts='2026-11-10T12:00:01Z',data=dict(envelope='EN-1',runtimeId='rt-1',door='steer')))
        memos.accept(dict(event='wrkq.kicker.delivery_admitted',ts='2026-11-10T12:00:02Z',data=dict(envelope='EN-1',runtimeId='rt-1',door='steer')))
        self.shadow.started_at=ms('2026-11-10T12:00:00Z')
        self.shadow.source.memos=memos
        calls=[]
        def reconstruct(mail,detail,store,admission,history,now):
            calls.append(mail['id'])
            return dict(basis='reconstructed',at=admission['at'],runtime_id='rt-1',capability_source='port_probe',
                decision=dict(action='steer',reason='steer_capable'),missing_fields=[])
        self.shadow.source.first_from_intent=reconstruct
        self.shadow.apply('room.mail',change(row('mail-1',**dict(self.mail['payload'],state='acked')),reset=True))
        self.shadow.process_first_deliveries(ms('2026-11-10T12:00:03Z'))
        self.shadow.process_first_deliveries(ms('2026-11-10T12:00:04Z'))
        self.assertEqual(calls,['EN-1'])
        self.assertEqual(len([r for e,r in self.client.logs if e=='shadow.first_delivery']),1)
        self.assertEqual(self.decisions(),[])
