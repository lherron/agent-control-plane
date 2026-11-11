"""Ownership behaviour on private databases; never uses the installed program."""
import asyncio
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

from mail_delivery.delivery_owner import DeliveryOwner
from mail_delivery.deliverer_lock import DelivererLock
from mail_delivery.main import EntryLoop


class Ownership(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'injector.sqlite'
        self.flag = DeliveryOwner(self.path)
        self.addCleanup(self.flag.close)

    def test_default_and_reporting_do_not_choose_owner(self):
        self.assertEqual(self.flag.read()['owner'], 'injector')
        self.flag.report('port', 123)
        self.assertEqual(self.flag.read()['owner'], 'injector')
        self.flag.set_owner('port')
        self.assertEqual(self.flag.read()['delivering_pid'], 123)
        self.flag.clear()
        self.assertIsNone(self.flag.read()['delivering_pid'])
        self.flag.set_owner('injector')
        with self.assertRaises(ValueError):
            self.flag.set_owner('invalid')

    def test_lock_excludes_until_release_and_close(self):
        first, second = DelivererLock(self.path), DelivererLock(self.path)
        self.addCleanup(first.close)
        self.addCleanup(second.close)
        self.assertTrue(first.try_acquire())
        self.assertFalse(second.try_acquire())
        first.release()
        self.assertTrue(second.try_acquire())
        second.close()
        self.assertTrue(first.try_acquire())

    def test_killed_holder_and_cross_runtime_exclusion(self):
        source = "from mail_delivery.deliverer_lock import DelivererLock; import sys,time; l=DelivererLock(sys.argv[1]); assert l.try_acquire(); print('held',flush=True); time.sleep(60)"
        child = subprocess.Popen([sys.executable, '-c', source, str(self.path)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'held')
            lock = DelivererLock(self.path)
            self.addCleanup(lock.close)
            self.assertFalse(lock.try_acquire())
            child.kill()
            child.wait(timeout=5)
            self.assertTrue(lock.try_acquire())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()


class Entry(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'injector.sqlite'
        self.flag = DeliveryOwner(self.path)
        self.lock = DelivererLock(self.path)
        self.other = DelivererLock(self.path)
        self.addCleanup(self.flag.close)
        self.addCleanup(self.lock.close)
        self.addCleanup(self.other.close)
        self.program = SimpleNamespace(stopping=False, alive=lambda: None)
        self.events = []
        self.starts = 0
        self.stops = 0
        async def start():
            self.assertFalse(self.other.try_acquire())
            self.starts += 1
            async def stop():
                self.assertFalse(self.other.try_acquire())
                await asyncio.sleep(0)
                self.stops += 1
            return SimpleNamespace(stop=stop, state_path=str(self.path), import_marker={})
        self.loop = EntryLoop(self.program, self.flag, self.lock, start,
                              lambda event, **data: self.events.append((event, data)))

    async def test_flip_and_stop_before_release(self):
        await self.loop.step()
        self.assertEqual(self.starts, 0)
        self.flag.set_owner('port')
        await self.loop.step()
        self.assertEqual(self.starts, 1)
        self.assertEqual(self.flag.read()['delivering_pid'], os.getpid())
        self.flag.set_owner('injector')
        await self.loop.step()
        self.assertEqual(self.stops, 1)
        self.assertTrue(self.other.try_acquire())
        self.assertIsNone(self.flag.read()['delivering_owner'])

    async def test_waits_once_and_retries_without_bypass(self):
        self.other.try_acquire()
        self.flag.report('injector', 42)
        self.flag.set_owner('port')
        for _ in range(3):
            await self.loop.step()
        self.assertEqual(self.starts, 0)
        waits = [data for event, data in self.events if event == 'mail_delivery.lock_wait']
        self.assertEqual(waits, [{'holder_pid': 42}])
        self.other.release()
        await self.loop.step()
        self.assertEqual(self.starts, 1)

    async def test_stopping_retains_lock_and_starts_nothing(self):
        self.flag.set_owner('port')
        await self.loop.step()
        self.program.stopping = True
        self.flag.set_owner('injector')
        await self.loop.step()
        self.assertEqual(self.stops, 1)
        self.assertIsNone(self.flag.read()['delivering_pid'])
        self.assertFalse(self.other.try_acquire())

    async def test_double_flip_between_ticks_has_no_transition(self):
        self.flag.set_owner('port')
        self.flag.set_owner('injector')
        await self.loop.step()
        self.assertEqual(self.starts, 0)

    async def test_failed_start_releases_for_retry(self):
        async def fail():
            raise RuntimeError('handshake refused')
        self.loop.start = fail
        self.flag.set_owner('port')
        await self.loop.step()
        self.assertTrue(self.other.try_acquire())
        self.assertIsNone(self.flag.read()['delivering_pid'])
