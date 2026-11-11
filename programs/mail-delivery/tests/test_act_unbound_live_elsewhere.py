"""T-12214 — a node never fails mail for a scope that has a live runtime on
another node (policy/__tests__/t12214-unbound-live-elsewhere.test.ts)."""
import unittest

from mail_delivery.act_contracts import HrcDomainError, HrcErrorCode
from mail_delivery.act_target_driver import drive_mail_target_once
from .act_kicker_fake import SCOPE_REF, TARGET_REF, Harness

PARTICIPANT_ONLY = (f'{SCOPE_REF} is participant-only, no seat registered. Register its direct participant '
                    'before sending mail to this scope.')


class UnboundLiveElsewhereTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()
        self.births = 0

        async def none(*_args):
            return None

        async def nothing(*_args):
            return []

        async def ensure(*_args):
            self.births += 1
            raise HrcDomainError(HrcErrorCode.STALE_CONTEXT, PARTICIPANT_ONLY,
                                 dict(scopeRef=SCOPE_REF, reason='participant-only', retryable=False))
        self.h.port.target_by_session_ref = none
        self.h.port.live_runtimes = nothing
        self.h.port.ensure_target_session = ensure

    async def asyncTearDown(self):
        await self.h.close()

    def live_on(self, live_node_ids, unanswered_node_ids=()):
        async def federated(_scope_ref):
            return dict(localNodeId=self.h.context.node_id, liveNodeIds=list(live_node_ids),
                        unansweredNodeIds=list(unanswered_node_ids))
        self.h.port.federated_live_runtimes = federated

    async def drive_three_times(self):
        for _ in range(3):
            self.h.context.mail_kicker_birth_sweep_backoff.clear()
            await drive_mail_target_once(self.h.context, TARGET_REF, 'periodic')

    async def test_skips_the_target_as_foreign_homed_instead_of_launching_or_failing_it(self):
        envelope = self.h.ledger.say()
        self.live_on(['svc-peer'])
        await self.drive_three_times()
        self.assertEqual(self.births, 0)
        self.assertEqual(self.h.ledger.fail_requests, [])
        self.assertEqual(self.h.ledger.envelopes[envelope['id']]['state'], 'pending')
        self.assertIsNone(self.h.store.launch_failures.get(envelope['id']))
        self.assertTrue(any(entry['detail'].get('phase') == 'home_resolution' and entry['detail'].get('outcome') == 'skipped'
                            and entry['detail'].get('reason') == 'foreign_home'
                            and entry['detail'].get('homeNodeId') == 'svc-peer'
                            for entry in self.h.events('wrkq.kicker.drive_phase')))
        self.assertLessEqual(dict(scopeRef=SCOPE_REF, homeNodeId='svc-peer', source='federated-runtime').items(),
                             self.h.events('wrkq.kicker.foreign_home_skipped')[0]['detail'].items())

    async def test_does_not_skip_when_the_scope_also_has_a_live_runtime_here(self):
        self.h.ledger.say()
        self.live_on([self.h.context.node_id, 'svc-peer'])
        await drive_mail_target_once(self.h.context, TARGET_REF, 'periodic')
        self.assertEqual(self.births, 1)
        self.assertEqual(self.h.events('wrkq.kicker.foreign_home_skipped'), [])

    async def test_does_not_skip_a_scope_bound_to_this_node_because_a_runtime_lingers_elsewhere(self):
        self.h.ledger.say()
        self.live_on(['svc-peer'])

        async def bindings():
            return dict(localNodeId=self.h.context.node_id,
                        bindings=[dict(scopeRef=SCOPE_REF, state='active', homeNodeId=self.h.context.node_id)])
        self.h.port.local_placement_bindings = bindings
        await drive_mail_target_once(self.h.context, TARGET_REF, 'periodic')
        self.assertEqual(self.births, 1)
        self.assertEqual(self.h.events('wrkq.kicker.foreign_home_skipped'), [])

    async def test_defers_never_fails_when_the_federated_read_itself_fails(self):
        envelope = self.h.ledger.say()

        async def failing(_scope_ref):
            raise Exception('federation projection unavailable')
        self.h.port.federated_live_runtimes = failing
        await self.drive_three_times()
        self.assertEqual(self.births, 0)
        self.assertEqual(self.h.ledger.fail_requests, [])
        self.assertEqual(self.h.ledger.envelopes[envelope['id']]['state'], 'pending')

    async def test_fails_the_summons_undeliverable_at_once_when_no_node_has_a_live_runtime(self):
        envelope = self.h.ledger.say()
        self.live_on([])
        outcome = await drive_mail_target_once(self.h.context, TARGET_REF, 'insert')
        self.assertEqual(self.births, 1)
        self.assertEqual(outcome, dict(outcome='undeliverable', failed=1))
        self.assertEqual(self.h.ledger.fail_requests, [dict(
            envelope=envelope['id'], reason='undeliverable', detail=f'birth_failed: {PARTICIPANT_ONLY}')])
        self.assertIsNone(self.h.store.launch_failures.get(envelope['id']))
        self.assertNotIn(TARGET_REF, self.h.store.mail_delivery.list_refused_birth_targets())

    async def test_leaves_the_envelope_pending_on_the_long_backoff_when_a_peer_did_not_answer(self):
        envelope = self.h.ledger.say()
        self.live_on([], ['svc-peer'])
        await self.drive_three_times()
        self.assertEqual(self.h.ledger.fail_requests, [])
        self.assertEqual(self.h.ledger.envelopes[envelope['id']]['state'], 'pending')
        self.assertIsNone(self.h.store.launch_failures.get(envelope['id']))
        self.assertIsNone(self.h.store.mail_delivery.get_intent(envelope['id']))
        self.assertTrue(self.h.events('wrkq.kicker.birth_not_placeable_here'))
        self.assertEqual(self.h.events('wrkq.kicker.drive_completed')[-1]['detail']['outcome'], 'not_placeable_here')

    async def test_skips_as_foreign_when_the_runtime_appears_elsewhere_between_the_read_and_the_refusal(self):
        envelope = self.h.ledger.say()
        reads = 0

        async def federated(_scope_ref):
            nonlocal reads
            live = [] if reads == 0 else ['svc-peer']
            reads += 1
            return dict(localNodeId=self.h.context.node_id, liveNodeIds=live, unansweredNodeIds=[])
        self.h.port.federated_live_runtimes = federated
        await drive_mail_target_once(self.h.context, TARGET_REF, 'insert')
        self.assertEqual(self.births, 1)
        self.assertEqual(self.h.ledger.fail_requests, [])
        self.assertEqual(self.h.ledger.envelopes[envelope['id']]['state'], 'pending')
        detail = self.h.events('wrkq.kicker.foreign_home_skipped')[0]['detail']
        self.assertEqual((detail['homeNodeId'], detail['source']), ('svc-peer', 'federated-runtime'))


if __name__ == '__main__':
    unittest.main()
