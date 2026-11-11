"""Regression cases requested by the T-13281 side-by-side review."""
import asyncio
from types import SimpleNamespace
import unittest
from mail_delivery.act_finished_task import task_id_of
from mail_delivery.act_hrc_facts import HrcFacts
from mail_delivery.act_internal import parse_session_ref
from mail_delivery.act_presentation import actionable_directives

SCOPE = 'agent:cody:project:agent-control-plane:task:T-13281'
TARGET = SCOPE + '/lane:main'


class ReviewFixTests(unittest.IsolatedAsyncioTestCase):
    def test_task_scope_parser_never_trims_identity(self):
        self.assertEqual(task_id_of(SCOPE), 'T-13281')
        for whitespace in (' ', '\n', '\ufeff', '\u00a0'):
            for value in (whitespace + SCOPE, SCOPE + whitespace):
                with self.subTest(value=value):
                    self.assertIsNone(task_id_of(value))

    async def test_cancelled_waiter_leaves_shared_fact_load_running(self):
        loop = asyncio.get_running_loop()
        result = loop.create_future()
        entered = asyncio.Event()
        calls = []
        async def target(ref):
            calls.append(ref)
            entered.set()
            return await result
        facts = HrcFacts(lambda: SimpleNamespace(target_by_session_ref=target), lambda: 0)
        facts.attach_lifecycle()
        first = asyncio.create_task(facts.target(TARGET))
        await entered.wait()
        second = asyncio.create_task(facts.target(TARGET))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertFalse(result.cancelled())
        self.assertIn('target:' + TARGET, facts.inflight)
        third = asyncio.create_task(facts.target(TARGET))
        await asyncio.sleep(0)
        session = {'hostSessionId': 'host', 'generation': 1}
        result.set_result(session)
        self.assertIs(await second, session)
        self.assertIs(await third, session)
        self.assertEqual(calls, [TARGET])
        self.assertIs(await facts.target(TARGET), session)
        self.assertNotIn('target:' + TARGET, facts.inflight)

    def test_javascript_trim_whitespace(self):
        # BOM is trimmed by JS, but not Python's default strip.
        self.assertEqual(parse_session_ref('\ufeff' + TARGET + '\ufeff'),
                         {'scopeRef': SCOPE, 'laneRef': 'main'})
        # U+001C is stripped by Python, but retained by JS trim.
        self.assertEqual(parse_session_ref('\x1c' + TARGET)['scopeRef'], '\x1c' + SCOPE)
        self.assertEqual(actionable_directives([{'envelope': {'materializationIntent': '\ufeff+node=svc\ufeff'}}]), '+node=svc')
        self.assertEqual(actionable_directives([{'envelope': {'materializationIntent': '\x1c+node=svc\x1c'}}]), '\x1c+node=svc\x1c')
        self.assertIsNone(actionable_directives([{'envelope': {'materializationIntent': '\ufeff'}}]))
