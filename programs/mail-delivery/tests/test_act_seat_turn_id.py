"""String(seat.turnId) parity regression from T-13283 scenario s02."""
from types import SimpleNamespace
import unittest
from mail_delivery.act_seat import observe_broker_seat


class SeatTurnIdTests(unittest.IsolatedAsyncioTestCase):
    async def test_javascript_string_conversion_on_both_turn_states(self):
        missing = object()
        cases = [(missing, 'undefined'), (None, 'null'), (True, 'true'), (False, 'false'),
                 ('turn-1', 'turn-1'), (42, '42'), (42.0, '42'), (1.25, '1.25'),
                 (-0.0, '0'), (1e-6, '0.000001'), (1e-7, '1e-7'),
                 (1e20, '100000000000000000000'), (1e21, '1e+21'),
                 (9007199254740993, '9007199254740992'),
                 (float('nan'), 'NaN'), (float('inf'), 'Infinity'), (float('-inf'), '-Infinity'),
                 ([], ''), ([None, True, 1.0], ',true,1'), ({}, '[object Object]')]
        for state in ('turn-active', 'turn-observed'):
            for value, expected in cases:
                with self.subTest(state=state, value=value):
                    seat = {'state': state}
                    if value is not missing:
                        seat['turnId'] = value
                    async def runtimes(host):
                        return [dict(runtimeId='rt', generation=1, controllerKind='harness-broker',
                                     activeInvocationId='inv', status='busy')]
                    async def probe(runtime):
                        return dict(probe={'seat': seat}, admissionClasses=['steer'])
                    server = SimpleNamespace(port=SimpleNamespace(runtimes_by_host_session=runtimes, seat=probe))
                    result = await observe_broker_seat(server, dict(hostSessionId='host', generation=1))
                    self.assertEqual(result['turnId'], expected)
