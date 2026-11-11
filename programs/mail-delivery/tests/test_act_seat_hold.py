"""Broker-seat and parked-human-input rules (t08094, t10233)."""
from types import SimpleNamespace
import unittest
from mail_delivery.act_seat import observe_broker_seat, normalize_probe_diagnostic
from mail_delivery.act_steer_hold import arm_quiet_pane_hold, steer_hold_for, observe_seat_activity


class SeatTests(unittest.IsolatedAsyncioTestCase):
    async def test_frozen_hello_and_current_generation(self):
        async def runtimes(host):
            return [dict(runtimeId='old', generation=0, controllerKind='harness-broker', activeInvocationId='i', status='ready'),
                    dict(runtimeId='new', generation=1, controllerKind='harness-broker', activeInvocationId='i', status='awaiting_input')]
        async def seat(runtime): return dict(probe={'seat': {'state': 'idle'}}, admissionClasses=['steer'])
        server = SimpleNamespace(port=SimpleNamespace(runtimes_by_host_session=runtimes, seat=seat))
        result = await observe_broker_seat(server, dict(hostSessionId='h', generation=1))
        self.assertEqual(result, dict(state='idle', runtimeId='new', steerCapable=True, awaitingInput=True))

    async def test_probe_diagnostic_bounded_and_missing(self):
        self.assertTrue(normalize_probe_diagnostic(None)['missing'])
        self.assertLessEqual(len(normalize_probe_diagnostic(dict(code='x'*90, message='y'*500))['message']), 240)

    async def test_hold_waits_for_reader_activity(self):
        logs = []
        server = SimpleNamespace(mail_kicker_steer_hold={}, now_ms=lambda: 1000,
                                 log=lambda *args: logs.append(args))
        await arm_quiet_pane_hold(server, 'rt', dict(invocationId='i', brokerSeq=10))
        self.assertEqual(steer_hold_for(server, dict(state='idle', runtimeId='rt', steerCapable=True)), 'pane_not_quiescent')
        observe_seat_activity(server, dict(runtimeId='rt', invocationId='i', seq=11, type='submission.rejected'))
        self.assertIn('rt', server.mail_kicker_steer_hold)
        observe_seat_activity(server, dict(runtimeId='rt', invocationId='i', seq=12, type='turn.tool_call'))
        self.assertNotIn('rt', server.mail_kicker_steer_hold)

    async def test_awaiting_input_then_resume_and_ceiling(self):
        server = SimpleNamespace(mail_kicker_steer_hold={}, now_ms=lambda: 0, log=lambda *args: None)
        seat = dict(state='turn-active', runtimeId='rt', steerCapable=True, awaitingInput=True)
        self.assertEqual(steer_hold_for(server, seat), 'awaiting_input')
        seat['awaitingInput'] = False
        self.assertIsNone(steer_hold_for(server, seat))
        await arm_quiet_pane_hold(server, 'rt', dict(invocationId='i', brokerSeq=1))
        server.now_ms = lambda: 600000
        self.assertIsNone(steer_hold_for(server, seat))
