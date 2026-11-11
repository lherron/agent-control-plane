"""The wrkq client against a recording `wrkq` stand-in: frames, identity, drops."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from mail_delivery import act_wrkq_ledger, gen_wrkq_pin
from mail_delivery.act_contracts import WrkqLedgerRequestError, WrkqLedgerUnavailableError
from tests.owner_standins import WrkqStandin

CHECKOUT = Path(__file__).absolute().parents[3]
PIN = gen_wrkq_pin.write_pin(CHECKOUT / gen_wrkq_pin.PROTOCOL_JS)
INITIALIZE = {'protocolVersion': PIN['PROTOCOL_VERSION'],
              'protocolSchemaHash': PIN['PROTOCOL_SCHEMA_HASH'],
              'server': {'version': 'test', 'revision': 'test'}}


class LedgerCase(unittest.IsolatedAsyncioTestCase):
    def standin(self, rules=(), initialize=INITIALIZE):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        standin = WrkqStandin(directory.name, {'initialize': initialize, 'rules': list(rules)})
        ledger = act_wrkq_ledger.create_wrkq_ledger(str(standin.command))
        self.addAsyncCleanup(ledger.close)
        return standin, ledger


class Frames(LedgerCase):
    async def test_initialize_then_principal_on_writes_and_none_on_principal_free_reads(self):
        standin, ledger = self.standin([
            {'method': 'wrkq.envelope.present', 'reply': {'result': {'recorded': True}}},
            {'method': 'wrkq.task.show', 'reply': {'result': {'id': 'T-1', 'state': 'open'}}},
        ])
        self.assertEqual(await ledger.present({'envelope': 'EN-1', 'driveAttemptId': 'd1'}),
                         {'recorded': True})
        self.assertEqual(await ledger.task_show({'task': 'T-1'}), {'id': 'T-1', 'state': 'open'})
        [frames] = standin.frames()
        self.assertEqual(frames[0], {
            'jsonrpc': '2.0', 'id': 'req_1', 'method': 'rpc.initialize', 'caller': 'hrc-mail-injector',
            'params': {'protocolVersion': PIN['PROTOCOL_VERSION'],
                       'client': {'name': 'hrc-mail-injector', 'version': '0.1.0'}}})
        self.assertEqual(frames[1]['params'],
                         {'principalRef': 'agent:hrc', 'envelope': 'EN-1', 'driveAttemptId': 'd1'})
        self.assertEqual(standin.connections()[0][2]['raw'],
                         '{"jsonrpc":"2.0","id":"req_2","method":"wrkq.envelope.present",'
                         '"caller":"hrc-mail-injector","params":{"principalRef":"agent:hrc",'
                         '"envelope":"EN-1","driveAttemptId":"d1"}}')
        self.assertEqual(frames[2]['params'], {'task': 'T-1'})
        self.assertEqual([frame['id'] for frame in frames], ['req_1', 'req_2', 'req_3'])

    async def test_environment_maps_the_hrc_authority_names(self):
        standin, ledger = self.standin([{'method': 'wrkq.envelope.show', 'reply': {'result': {}}}])
        with mock.patch.dict(os.environ, {'HRC_WRKQ_DB': ' rpc://h:1 ', 'HRC_WRKQD_TOKEN_FILE': '/t',
                                          'WRKQ_DB_PATH': '/old', 'WRKQD_TOKEN': 'secret'}):
            await ledger.envelope_show({'envelope': 'EN-1'})
        [conn] = standin.connections()
        self.assertEqual(conn[0]['argv'], ['rpc', '--stdio'])
        self.assertEqual(conn[0]['env'], {
            'PRAESIDIUM_CALLER': 'hrc-mail-injector', 'WRKQ_DB': 'rpc://h:1', 'WRKQ_DB_PATH': None,
            'WRKQ_DB_PATH_FILE': None, 'WRKQD_TOKEN': '', 'WRKQD_TOKEN_FILE': '/t'})

    async def test_commit_wait_parks_on_its_own_connection_with_a_clamped_timeout(self):
        standin, ledger = self.standin([
            {'method': 'wrkq.commit.wait', 'delay_ms': 600,
             'reply': {'result': {'token': 't2', 'changed': True}}},
            {'method': 'wrkq.envelope.show', 'reply': {'result': {'id': 'EN-1'}}},
        ])
        import asyncio
        parked = asyncio.ensure_future(ledger.commit_wait({'since': 't1', 'timeoutMs': 90_000}))
        await asyncio.sleep(0.2)
        self.assertEqual(await ledger.envelope_show({'envelope': 'EN-1'}), {'id': 'EN-1'})
        self.assertFalse(parked.done())
        self.assertEqual(await parked, {'token': 't2', 'changed': True})
        self.assertEqual(sorted((frames[1]['method'], frames[1]['params']) for frames in standin.frames()), [
            ('wrkq.commit.wait', {'since': 't1', 'timeoutMs': 25000}),
            ('wrkq.envelope.show', {'principalRef': 'agent:hrc', 'envelope': 'EN-1'})])
        await ledger.commit_wait({'timeoutMs': 5})
        self.assertEqual([frames[-1]['params'] for frames in standin.frames()
                          if frames[1]['method'] == 'wrkq.commit.wait'], [{'timeoutMs': 1000}])

    async def test_events_view_maps_rows_and_carries_the_cursor_without_a_high_water(self):
        standin, ledger = self.standin([
            {'method': 'wrkq.monitor.eventsView', 'match': {'cursor': 5}, 'reply': {'result': {
                'items': [{'id': 7, 'timestamp': 'ts', 'resource_type': 'envelope', 'resource_id': 'EN-1',
                           'event_type': 'envelope.created', 'payload': '{}', 'extra': 1},
                          {'id': 'x', 'resource_uuid': 3}, None],
                'high_water': 9}}},
            {'method': 'wrkq.monitor.eventsView', 'reply': {'result': {}}},
        ])
        view = await ledger.events_view({'cursor': 5, 'limit': 10})
        self.assertEqual(view, {'highWater': 9, 'items': [
            {'id': 7, 'timestamp': 'ts', 'resourceType': 'envelope', 'resourceId': 'EN-1',
             'eventType': 'envelope.created', 'payload': '{}'},
            {'id': 0, 'timestamp': '', 'resourceType': '', 'eventType': ''},
            {'id': 0, 'timestamp': '', 'resourceType': '', 'eventType': ''}]})
        self.assertEqual(await ledger.events_view({'cursor': 11}), {'items': [], 'highWater': 11})
        self.assertNotIn('principalRef', standin.frames()[0][1]['params'])


class Failures(LedgerCase):
    async def test_a_refusal_keeps_the_connection(self):
        standin, ledger = self.standin([
            {'method': 'wrkq.envelope.fail', 'reply': {'error': {
                'code': -32009, 'message': 'conflict', 'data': {'code': 'WRKQ_CONFLICT'}}}},
            {'method': 'wrkq.envelope.show', 'reply': {'result': {'id': 'EN-1'}}},
        ])
        with self.assertRaises(WrkqLedgerRequestError) as caught:
            await ledger.fail({'envelope': 'EN-1', 'reason': 'ignored', 'runtime': 'rt'})
        error = caught.exception
        self.assertEqual((str(error), error.method, error.code, error.data), (
            'wrkq wrkq.envelope.fail refused: conflict', 'wrkq.envelope.fail', -32009,
            {'code': 'WRKQ_CONFLICT'}))
        await ledger.envelope_show({'envelope': 'EN-1'})
        self.assertEqual(len(standin.connections()), 1)

    async def test_an_exit_drops_the_connection_and_is_never_replayed(self):
        standin, ledger = self.standin([
            {'method': 'wrkq.envelope.present', 'action': 'exit', 'exit_code': 3},
            {'method': 'wrkq.envelope.show', 'reply': {'result': {'id': 'EN-2'}}},
        ])
        with self.assertRaises(WrkqLedgerUnavailableError) as caught:
            await ledger.present({'envelope': 'EN-1'})
        self.assertEqual((str(caught.exception), caught.exception.method), (
            'wrkq wrkq.envelope.present failed: work rpc process exited (code=3)', 'wrkq.envelope.present'))
        await ledger.envelope_show({'envelope': 'EN-2'})
        first, second = standin.frames()
        self.assertEqual([frame['method'] for frame in first], ['rpc.initialize', 'wrkq.envelope.present'])
        self.assertEqual([frame['method'] for frame in second], ['rpc.initialize', 'wrkq.envelope.show'])

    async def test_a_non_json_line_is_protocol_corruption(self):
        standin, ledger = self.standin([{'method': 'wrkq.envelope.show', 'action': 'corrupt', 'text': 'oops'}])
        with self.assertRaises(WrkqLedgerUnavailableError) as caught:
            await ledger.envelope_show({'envelope': 'EN-1'})
        self.assertEqual(str(caught.exception), 'wrkq wrkq.envelope.show failed: work rpc protocol '
                                                'corruption: non-JSON frame on stdout: oops')

    async def test_a_deadline_kills_the_child_with_sigterm(self):
        standin, ledger = self.standin([{'method': 'wrkq.envelope.show', 'action': 'hang'}])
        with mock.patch.object(act_wrkq_ledger, 'REQUEST_TIMEOUT_MS', 300):
            with self.assertRaises(WrkqLedgerUnavailableError) as caught:
                await ledger.envelope_show({'envelope': 'EN-1'})
        self.assertEqual(str(caught.exception), 'wrkq wrkq.envelope.show did not answer within 300ms')
        import asyncio
        await asyncio.sleep(0.3)
        self.assertEqual(standin.connections()[0][-1], {'signal': 'SIGTERM'})

    async def test_a_missing_command_is_unavailable(self):
        ledger = act_wrkq_ledger.create_wrkq_ledger('/nonexistent/wrkq')
        with self.assertRaises(WrkqLedgerUnavailableError) as caught:
            await ledger.envelope_show({'envelope': 'EN-1'})
        self.assertTrue(str(caught.exception).startswith('wrkq wrkq.envelope.show failed: '))


class Closing(LedgerCase):
    async def test_close_shuts_down_gracefully_kills_the_wait_and_refuses_afterwards(self):
        standin, ledger = self.standin([
            {'method': 'wrkq.commit.wait', 'action': 'hang'},
            {'method': 'wrkq.envelope.show', 'reply': {'result': {}}},
        ])
        import asyncio
        parked = asyncio.ensure_future(ledger.commit_wait({}))
        await ledger.envelope_show({'envelope': 'EN-1'})
        await asyncio.sleep(0.2)
        await ledger.close()
        with self.assertRaises(WrkqLedgerUnavailableError):
            await parked
        with self.assertRaises(WrkqLedgerUnavailableError) as caught:
            await ledger.envelope_show({'envelope': 'EN-1'})
        self.assertEqual(str(caught.exception), 'wrkq ledger is closed')
        logs = {conn[2]['frame']['method']: conn for conn in standin.connections()}
        self.assertEqual(logs['wrkq.commit.wait'][-1], {'signal': 'SIGTERM'})
        delivery = logs['wrkq.envelope.show']
        self.assertEqual(delivery[-2]['frame'], {'jsonrpc': '2.0', 'id': 'req_3', 'method': 'rpc.shutdown',
                                                 'caller': 'hrc-mail-injector'})
        self.assertEqual(delivery[-1], {'eof': True})


class StartCheck(LedgerCase):
    async def test_verify_accepts_the_pinned_hash_through_an_ordinary_refusal(self):
        _, ledger = self.standin([{'method': 'wrkq.envelope.show', 'reply': {'error': {
            'code': -32004, 'message': 'not found'}}}])
        self.assertEqual(await ledger.verify(), {'protocolVersion': PIN['PROTOCOL_VERSION'],
                                                 'protocolSchemaHash': PIN['PROTOCOL_SCHEMA_HASH']})

    async def test_verify_names_both_hashes_when_wrkq_differs(self):
        _, ledger = self.standin([{'method': 'wrkq.envelope.show', 'reply': {'result': {}}}],
                                 initialize=dict(INITIALIZE, protocolSchemaHash='sha256:' + '0' * 64))
        with self.assertRaises(act_wrkq_ledger.WrkqProtocolMismatch) as caught:
            await ledger.verify()
        self.assertIn('sha256:' + '0' * 64, str(caught.exception))
        self.assertIn(PIN['PROTOCOL_SCHEMA_HASH'], str(caught.exception))

    async def test_verify_reports_a_refused_handshake(self):
        _, ledger = self.standin([{'method': 'rpc.initialize', 'reply': {'error': {
            'code': -32010, 'message': 'protocol mismatch',
            'data': {'expected': '2026-01-01', 'actual': PIN['PROTOCOL_VERSION'],
                     'serverProtocolSchemaHash': 'sha256:' + '1' * 64}}}}])
        with self.assertRaises(act_wrkq_ledger.WrkqProtocolMismatch) as caught:
            await ledger.verify()
        self.assertIn('sha256:' + '1' * 64, str(caught.exception))
        self.assertIn(PIN['PROTOCOL_SCHEMA_HASH'], str(caught.exception))


class Generator(unittest.TestCase):
    def test_reads_exactly_one_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'protocol.js'
            source.write_text('export const PROTOCOL_VERSION = "2026-06-30";\n'
                              'export const PROTOCOL_SCHEMA_HASH = "sha256:' + 'a' * 64 + '";\n')
            output = Path(directory) / 'pin.py'
            gen_wrkq_pin.write_pin(source, output)
            namespace = {}
            exec(output.read_text(), namespace)
            self.assertEqual(namespace['PROTOCOL_SCHEMA_HASH'], 'sha256:' + 'a' * 64)
            source.write_text('export const PROTOCOL_VERSION = "2026-06-30";\n')
            with self.assertRaises(ValueError):
                gen_wrkq_pin.write_pin(source, output)


if __name__ == '__main__':
    unittest.main()
