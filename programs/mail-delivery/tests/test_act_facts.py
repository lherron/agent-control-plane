"""Behaviour port of keyed-facts rules from t12430-keyed-facts.test.ts."""
import asyncio
from types import SimpleNamespace
import unittest
from mail_delivery.act_hrc_facts import HrcFacts, FOREIGN_HOME_TTL_MS, DESIGNATIONS_TTL_MS

TARGET = 'agent:cody:project:agent-control-plane:task:T-12430/lane:main'
SCOPE = TARGET.split('/')[0]


class FactsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = 0
        self.calls = []
        self.session = {'hostSessionId': 'host', 'generation': 1}
        async def target(ref):
            self.calls.append(('target', ref))
            return self.session
        async def home(ref):
            self.calls.append(('home', ref))
            return {'homeNodeId': 'svc', 'source': 'registry'}
        async def designations():
            self.calls.append(('designations',))
            return {'designations': []}
        self.port = SimpleNamespace(target_by_session_ref=target, resolve_foreign_home=home,
                                    unborn_designations=designations)
        self.facts = HrcFacts(lambda: self.port, lambda: self.clock)

    def event(self, kind, **changes):
        return dict(eventKind=kind, scopeRef=SCOPE, laneRef='main', hostSessionId='host', generation=1, **changes)

    async def test_degraded_reads_bypass_cache(self):
        await self.facts.target(TARGET)
        await self.facts.target(TARGET)
        self.assertEqual(len(self.calls), 2)

    async def test_structural_event_dirties_exact_key(self):
        self.facts.attach_lifecycle()
        await self.facts.target(TARGET)
        await self.facts.target(TARGET + '-other')
        self.calls.clear()
        self.facts.observe(self.event('runtime.created'))
        await self.facts.target(TARGET)
        await self.facts.target(TARGET + '-other')
        self.assertEqual(self.calls, [('target', TARGET)])

    async def test_benign_and_unknown_kinds(self):
        self.facts.attach_lifecycle()
        await self.facts.target(TARGET)
        self.calls.clear()
        for kind in ('turn.tool_call', 'turn.completed', 'broker.seat.transition', 'runtime.context.updated'):
            self.facts.observe(self.event(kind))
        await self.facts.target(TARGET)
        self.assertEqual(self.calls, [])
        self.facts.observe(self.event('session.teleported'))
        await self.facts.target(TARGET)
        self.assertEqual(self.calls, [('target', TARGET)])

    async def test_invalidation_during_read_wins(self):
        self.facts.attach_lifecycle()
        pending = asyncio.get_running_loop().create_future()
        async def read(ref): return await pending
        self.port.target_by_session_ref = read
        task = asyncio.create_task(self.facts.target(TARGET))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.facts.observe(self.event('session.created'))
        pending.set_result(self.session)
        self.assertIs(await task, self.session)
        self.assertNotIn('target:' + TARGET, self.facts.entries)

    async def test_foreign_ttl_and_invalidate(self):
        self.facts.attach_lifecycle()
        await self.facts.foreign_home(SCOPE)
        await self.facts.foreign_home(SCOPE)
        self.assertEqual(len(self.calls), 1)
        self.clock = FOREIGN_HOME_TTL_MS
        await self.facts.foreign_home(SCOPE)
        self.facts.invalidate_target(TARGET)
        await self.facts.foreign_home(SCOPE)
        self.assertEqual(len(self.calls), 3)

    async def test_miss_refreshes_designations_once(self):
        self.facts.attach_lifecycle()
        self.session = None
        await self.facts.unborn_designations()
        await self.facts.target(TARGET)
        await self.facts.target(TARGET)
        self.assertEqual(self.facts.reads['designations'], 2)

    async def test_resume_resets_once(self):
        self.facts.attach_lifecycle()
        self.facts.attach_broker()
        await self.facts.target(TARGET)
        self.facts.lifecycle_stream_state('down')
        self.assertFalse(self.facts.serving)
        self.facts.lifecycle_stream_state('resumed')
        await self.facts.target(TARGET)
        await self.facts.target(TARGET)
        self.assertEqual(self.facts.reads['target'], 2)
