"""Drive rules ported before implementation from the named injector regressions.

Reconcile, wake and terminal implementation rules belong to the wake task;
these tests exercise this task's actual drive and landing with fake owners.
"""
import unittest
from .act_fake import FakeContext, TARGET, SCOPE, broker_record
from mail_delivery.act_target_driver import drive_mail_target_once
from mail_delivery.act_landing import observe_broker_landing
from mail_delivery.act_delivery import deliver_to_seat
from mail_delivery.act_presentation import read_actionable_envelopes
from mail_delivery.act_contracts import HrcDomainError


class DriveTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self): self.c = FakeContext()
    def tearDown(self): self.c.close()

    async def drive(self): return await drive_mail_target_once(self.c, TARGET, 'insert')

    async def test_steer_first_and_write_ahead_no_receipt_on_admission(self):
        row = self.c.ledger.say()
        async def steer(*args):
            self.assertIsNotNone(self.c.store.mail_delivery.get_intent(row['id']))
            return self.c.port.dispatch_result
        self.c.port.steer = steer
        await self.drive()
        self.assertEqual(self.c.store.mail_delivery.get_intent(row['id']).door, 'steer')
        self.assertEqual(self.c.ledger.rows[row['id']]['presentedTo'], [])
        self.assertEqual(await read_actionable_envelopes(self.c, TARGET), [])

    async def test_absorbed_and_executed_land_once(self):
        for kind, outcome in (('submission.absorbed', 'steered'), ('submission.executed', 'executed')):
            with self.subTest(kind=kind):
                row = self.c.ledger.say()
                self.c.port.dispatch_result['submissionId'] = 'sub-'+row['id']
                await self.drive()
                record = broker_record(kind, dict(submissionId='sub-'+row['id']))
                await observe_broker_landing(self.c, record)
                await observe_broker_landing(self.c, record)
                self.assertIsNone(self.c.store.mail_delivery.get_intent(row['id']))
                self.assertEqual(self.c.ledger.rows[row['id']]['presentedTo'][0]['deliveryOutcome'], outcome)

    async def test_midturn_write_lands_but_started_does_not(self):
        row = self.c.ledger.say(obligation='fyi')
        await self.drive()
        await observe_broker_landing(self.c, broker_record('input.accepted', dict(inputId='sub-1', disposition='started')))
        self.assertIsNotNone(self.c.store.mail_delivery.get_intent(row['id']))
        await observe_broker_landing(self.c, broker_record('input.accepted', dict(inputId='sub-1', disposition='attempted_steer')))
        self.assertEqual(self.c.ledger.rows[row['id']]['presentedTo'][0]['deliveryOutcome'], 'steered')

    async def test_capability_selects_enqueue(self):
        self.c.port.probe['admissionClasses'] = ['enqueue']
        row = self.c.ledger.say()
        await self.drive()
        self.assertEqual(self.c.store.mail_delivery.get_intent(row['id']).door, 'enqueue')

    async def test_definitive_refusal_releases_uncertain_does_not(self):
        row = self.c.ledger.say()
        self.c.port.replies['steer'] = [HrcDomainError('presentation_conflict', 'no write')]
        await self.drive()
        self.assertIsNone(self.c.store.mail_delivery.get_intent(row['id']))
        self.c.port.replies['steer'] = [Exception('response lost')]
        await self.drive()
        self.assertEqual(self.c.store.mail_delivery.get_intent(row['id']).uncertain_cause, 'dispatch_error')

    async def test_absent_session_row_uses_cold_birth(self):
        self.c.port.runtimes = []
        row = self.c.ledger.say()
        await self.drive()
        self.assertTrue(any(call['method'] == 'ensure_target_session' for call in self.c.transcript))
        self.assertEqual(self.c.store.mail_delivery.get_intent(row['id']).door, 'invoke')

    async def test_deterministic_birth_refusal_fails_now(self):
        self.c.port.runtimes = []
        self.c.port.replies['ensure_target_session'] = [HrcDomainError('declaration_invalid', 'bad task worktree')]
        row = self.c.ledger.say()
        await self.drive()
        self.assertTrue(self.c.ledger.rows[row['id']]['terminal'])

    async def test_local_placement_refusal_leaves_pending(self):
        self.c.port.runtimes = []
        self.c.port.replies['ensure_target_session'] = [HrcDomainError('declaration_invalid', 'no checkout', dict(source='project-targets', home='/node'))]
        row = self.c.ledger.say()
        result = await self.drive()
        self.assertEqual(result['outcome'], 'birth-refused')
        self.assertFalse(self.c.ledger.rows[row['id']]['terminal'])
        self.assertIsNone(self.c.store.mail_delivery.get_intent(row['id']))

    async def test_retired_host_retries_without_failure_budget(self):
        self.c.port.runtimes = []
        self.c.port.replies['ensure_target_session'] = [HrcDomainError('stale_context', 'rotated', dict(reason='host_session_retired'))]
        row = self.c.ledger.say()
        await self.drive()
        self.assertIsNone(self.c.store.launch_failures.get(row['id']))
        self.assertIsNone(self.c.store.mail_delivery.get_intent(row['id']))
        await self.drive()
        self.assertIsNotNone(self.c.store.mail_delivery.get_intent(row['id']))

    async def test_launch_third_failure_exhausts_budget(self):
        self.c.port.runtimes = []
        row = self.c.ledger.say()
        for i in range(3):
            self.c.clock += 300000
            self.c.port.replies['ensure_target_session'] = [Exception('cannot birth')]
            await self.drive()
        self.assertEqual(self.c.store.launch_failures.get(row['id']).attempts, 3)
        self.assertTrue(self.c.ledger.rows[row['id']]['terminal'])

    async def test_cwd_missing_fails_once(self):
        row = self.c.ledger.say()
        self.c.port.replies['steer'] = [HrcDomainError('cwd_missing', 'gone /work', dict(cwd='/work'))]
        await self.drive()
        await self.drive()
        self.assertTrue(self.c.ledger.rows[row['id']]['terminal'])
        self.assertEqual(sum(call['method'] == 'fail' for call in self.c.transcript), 1)

    async def test_finished_task_fyi_closes_without_birth(self):
        self.c.port.runtimes = []
        self.c.ledger.task_state = 'completed'
        row = self.c.ledger.say(obligation='fyi')
        await self.drive()
        self.assertTrue(self.c.ledger.rows[row['id']]['terminal'])
        self.assertFalse(any(call['method'] == 'ensure_target_session' for call in self.c.transcript))

    async def test_parked_seat_holds_without_opening_intent(self):
        self.c.port.runtimes[0]['status'] = 'awaiting_input'
        row = self.c.ledger.say()
        await self.drive()
        self.assertIsNone(self.c.store.mail_delivery.get_intent(row['id']))
        self.c.port.runtimes[0]['status'] = 'ready'
        await self.drive()
        self.assertIsNotNone(self.c.store.mail_delivery.get_intent(row['id']))

    async def test_two_envelopes_submit_individually(self):
        a, b = self.c.ledger.say(), self.c.ledger.say()
        await self.drive()
        self.assertEqual(len(self.c.store.mail_delivery.list_open_intents()), 2)
        self.assertEqual(sum(call['method'] == 'steer' for call in self.c.transcript), 2)

    async def test_digest_members_share_one_submission(self):
        for _ in range(3): self.c.ledger.say(obligation='fyi', createdAt='2026-01-01T00:00:00.000Z')
        await self.drive()
        self.assertEqual(sum(call['method'] == 'steer' for call in self.c.transcript), 1)
        await observe_broker_landing(self.c, broker_record('submission.absorbed', dict(submissionId='sub-1')))
        self.assertEqual(len(self.c.store.mail_delivery.list_open_intents()), 0)
        self.assertTrue(all(row['presentedTo'] for row in self.c.ledger.rows.values()))
