from unittest import TestCase
from unittest.mock import patch
from mail_delivery.hrc_read import HrcRead, allowed


class ReadRoutes(TestCase):
    def test_read_allowlist(self):
        for method, path in [('GET', '/v1/federation/locate?scopeRef=agent:cody'),
                             ('GET', '/v1/runtimes/rt-1/seat'),
                             ('GET', '/v1/sessions/by-host/hsid-1'),
                             ('GET', '/v1/broker-events/query?op=disposition'),
                             ('POST', '/v1/runtimes/inspect'),
                             ('POST', '/v1/declarations/resolve'),
                             ('POST', '/v1/submissions/preempt/admission')]:
            self.assertTrue(allowed(method, path), (method, path))

    def test_every_other_route_refused_before_any_socket_is_opened(self):
        with patch('socket.socket', side_effect=AssertionError('must not connect')):
            client = HrcRead('/does/not/exist')
            for method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'):
                for path in ('/v1/submissions/preempt', '/v1/submissions/steer',
                             '/v1/submissions/enqueue', '/v1/submissions/withdraw',
                             '/v1/submissions/preempt/admission/extra',
                             '/v1/targets/ensure', '/v1/runtimes/start',
                             '/v1/terminate', '/v1/server/restart', '/unknown',
                             '/v1/runtimes/../start/seat', '//evil/v1/runtimes',
                             '/v1/runtimes/rt%2f..%2fstart/seat'):
                    with self.assertRaises(PermissionError, msg=(method, path)):
                        client.request(method, path)
