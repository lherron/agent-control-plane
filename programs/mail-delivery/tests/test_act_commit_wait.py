"""Injector commit wake scheduler (policy/__tests__/commit-wait.test.ts)."""
import asyncio
import tempfile
import time
import unittest
from datetime import datetime, timezone

from mail_delivery.act_controller import create_mail_kicker
from mail_delivery.store import open_store


class Fixture:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.offset_ms = 0
        self.t0 = time.monotonic()
        self.store = open_store(self.tmp.name + '/s.sqlite',
                                lambda: datetime.fromtimestamp(self.now_ms() / 1000, timezone.utc))
        self.calls = []
        self.waits = []
        fixture = self

        class Port:
            async def events_head(self):
                return dict(hrcSeq=0, brokerCommit=0)

            async def subscribe_lifecycle(self, _input):
                async def unsubscribe():
                    return None
                return unsubscribe

            subscribe_broker = subscribe_lifecycle

        class Ledger:
            async def commit_wait(self, params):
                fixture.calls.append('wait')
                if params.get('since') is None:
                    return dict(token='boot', changed=True)
                future = asyncio.get_running_loop().create_future()
                fixture.waits.append(dict(params=params, future=future))
                return await future

        self.kicker = create_mail_kicker(
            dict(store=self.store, port=Port(), ledger=Ledger(), node_id='max3', foreign_home_memo={},
                 log=lambda *_: None, now_ms=self.now_ms),
            dict(enabled=True, sweep_interval_ms=10))

        async def tail():
            self.calls.append('tail')

        async def sweep():
            self.calls.append('sweep')
        self.kicker.run_tail_once = tail
        self.kicker.run_sweep_once = sweep

    def now_ms(self):
        return 1794355200000 + self.offset_ms + int((time.monotonic() - self.t0) * 1000)

    def resolve(self, value):
        self.waits.pop(0)['future'].set_result(value)

    def count(self, name):
        return self.calls.count(name)

    def close(self):
        self.store.close()
        self.tmp.cleanup()


class CommitWaitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.f = Fixture()

    async def asyncTearDown(self):
        await self.f.kicker.stop()
        self.f.close()

    async def test_takes_token_before_read_tails_only_on_coarse_changes_and_stops_while_parked(self):
        f = self.f
        await f.kicker.start()
        await asyncio.sleep(0.02)
        self.assertEqual(f.calls[:3], ['wait', 'tail', 'wait'])
        self.assertEqual(f.waits[0]['params'], dict(since='boot', timeoutMs=25000))
        f.resolve(dict(token='next', changed=True))
        await asyncio.sleep(0.02)
        self.assertEqual(f.count('sweep'), 0)
        await f.kicker.stop()
        if f.waits and not f.waits[0]['future'].done():
            f.resolve(dict(token='late', changed=True))
        await asyncio.sleep(0.01)
        self.assertEqual(f.count('tail'), 2)

    async def test_paces_immediate_unchanged_capacity_replies_without_sweeping(self):
        f = self.f
        await f.kicker.start()
        await asyncio.sleep(0.005)
        f.resolve(dict(token='boot', changed=False))
        await asyncio.sleep(0.002)
        self.assertEqual(f.count('tail'), 1)
        await asyncio.sleep(0.02)
        self.assertEqual(f.count('tail'), 2)
        self.assertEqual(f.count('sweep'), 0)

    async def test_runs_recovery_at_300_seconds_even_when_unrelated_commits_keep_waking_the_tail(self):
        f = self.f
        await f.kicker.start()
        await asyncio.sleep(0.01)
        f.offset_ms += 299_000
        f.resolve(dict(token='unrelated', changed=True))
        await asyncio.sleep(0.02)
        self.assertEqual(f.count('sweep'), 0)
        self.assertEqual(f.waits[0]['params']['timeoutMs'], 1000)
        f.offset_ms += 1_001
        f.resolve(dict(token='another-unrelated', changed=True))
        await asyncio.sleep(0.02)
        self.assertEqual(f.count('sweep'), 1)
        self.assertEqual(f.count('tail'), 3)


if __name__ == '__main__':
    unittest.main()
