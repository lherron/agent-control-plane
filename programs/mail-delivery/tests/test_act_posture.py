"""Mail injector HRC ownership admission (test/posture.test.ts) and the start
path's gates (index.ts: posture before the store opens, the import marker)."""
import asyncio
import json
import os
import socket
import sqlite3
import tempfile
import threading
import unittest

from mail_delivery.act_hrc_port import normalize_failure_notice_dispatch_result
from mail_delivery.act_injector import assert_mail_injector_posture, start_mail_injector
from mail_delivery.store import open_store


class PostureTests(unittest.TestCase):
    def test_accepts_bridge_and_deletion_postures_only(self):
        assert_mail_injector_posture('disabled')
        assert_mail_injector_posture('absent')

    def test_refuses_concurrent_or_malformed_hrc_delivery_ownership(self):
        with self.assertRaisesRegex(Exception, 'in-process'):
            assert_mail_injector_posture('in-process')
        with self.assertRaisesRegex(Exception, 'recognized'):
            assert_mail_injector_posture(None)

    def test_settles_a_sender_failure_notice_when_hrc_reports_a_completed_enqueue(self):
        options = dict(ttlMs=1_000, submissionOrigin=dict(principalRef='system:hrc-kicker',
                                                          scopeRef='agent:cody:project:hrc-runtime'))
        self.assertEqual(normalize_failure_notice_dispatch_result(dict(status='completed', runId='run-1'), options),
                         dict(status='started', runId='run-1'))
        mail = normalize_failure_notice_dispatch_result(
            dict(status='completed', runId='run-2'),
            dict(options, submissionOrigin=dict(options['submissionOrigin'], envelopeId='EN-15076')))
        self.assertEqual(mail['status'], 'completed')


def serve_status(path, posture):
    """A one-route HRC stand-in: GET /v1/status answers {mailKicker: posture}."""
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(4)

    def run():
        while True:
            try:
                connection, _ = server.accept()
            except OSError:
                return
            with connection:
                connection.recv(65536)
                body = json.dumps({} if posture is None else dict(mailKicker=posture)).encode()
                connection.sendall(b'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n'
                                   + f'content-length: {len(body)}\r\nconnection: close\r\n\r\n'.encode() + body)
    threading.Thread(target=run, daemon=True).start()
    return server


class StartGateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp')
        self.socket_path = os.path.join(self.tmp.name, 'hrc.sock')
        self.state_path = os.path.join(self.tmp.name, 'state', 'injector.sqlite')

    async def asyncTearDown(self):
        self.server.close()
        self.tmp.cleanup()

    async def test_refuses_an_in_process_posture_before_the_store_is_opened(self):
        self.server = serve_status(self.socket_path, 'in-process')
        with self.assertRaisesRegex(Exception, 'in-process'):
            await start_mail_injector(dict(socket_path=self.socket_path, state_path=self.state_path, node_id='max3'))
        self.assertFalse(os.path.exists(self.state_path))

    async def test_refuses_a_store_without_an_import_marker_and_closes_it(self):
        self.server = serve_status(self.socket_path, 'absent')
        with self.assertRaisesRegex(Exception, 'import marker'):
            await start_mail_injector(dict(socket_path=self.socket_path, state_path=self.state_path, node_id='max3'))
        # Closed: a second writer can take an exclusive lock at once.
        db = sqlite3.connect(self.state_path, timeout=0)
        db.execute('BEGIN EXCLUSIVE')
        db.rollback()
        db.close()

    async def test_reads_the_marker_for_the_named_import_source(self):
        self.server = serve_status(self.socket_path, 'absent')
        open_store(self.state_path).close()
        db = sqlite3.connect(self.state_path)
        db.execute('INSERT INTO injector_store_imports (source_path, imported_at) VALUES (?, ?)',
                   ('/seed.sqlite', '2026-11-11T00:00:00.000Z'))
        db.commit()
        db.close()
        with self.assertRaisesRegex(Exception, 'import marker'):
            await start_mail_injector(dict(socket_path=self.socket_path, state_path=self.state_path, node_id='max3',
                                           import_from=dict(sourcePath='/other.sqlite')))


if __name__ == '__main__':
    unittest.main()
