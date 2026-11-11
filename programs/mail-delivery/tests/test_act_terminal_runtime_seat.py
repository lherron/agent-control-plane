"""T-10286 — a terminal broker runtime is not a seat
(policy/__tests__/t10286-terminal-runtime-seat.test.ts)."""
import unittest

from mail_delivery.act_js import iso_from_ms
from mail_delivery.act_target_driver import drive_mail_target_once
from .act_kicker_fake import RUNTIME_ID, TARGET_REF, Harness


class TerminalRuntimeSeatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness()

    async def asyncTearDown(self):
        await self.h.close()

    def broker_runtime_in(self, status):
        now = iso_from_ms(self.h.now_ms())
        self.h.db.update_runtime(RUNTIME_ID, controllerKind='harness-broker', activeInvocationId='inv-t10286',
                                 status=status, statusChangedAt=now, updatedAt=now)

    async def test_selects_a_live_broker_runtime_whose_probe_fails_as_unavailable(self):
        self.broker_runtime_in('ready')
        self.h.ledger.say()
        await drive_mail_target_once(self.h.context, TARGET_REF, 'insert')
        self.assertEqual(self.h.dispatches, [])
        self.assertEqual(self.h.events('wrkq.kicker.seat_not_ready')[0]['detail']['observedSeatState'],
                         'unavailable')

    async def test_reads_a_terminal_broker_runtime_as_an_absent_seat(self):
        for status in ('failed', 'stopped', 'disposed', 'exited', 'crashed', 'detached'):
            with self.subTest(status=status):
                self.h.dispatches.clear()
                self.broker_runtime_in(status)
                envelope = self.h.ledger.say()
                await drive_mail_target_once(self.h.context, TARGET_REF, 'insert')
                self.assertEqual(self.h.store.mail_delivery.get_intent(envelope['id']).door, 'invoke')
                self.assertEqual(len(self.h.dispatches), 1)
                self.assertIs(self.h.dispatches[0].get('launchPromptOnColdBirth'), True)
                # Each status is its own fixture in the TypeScript; release this body.
                self.h.store.mail_delivery.clear_intent(envelope['id'])
                self.h.ledger.envelopes[envelope['id']].update(state='failed', terminal=True)


if __name__ == '__main__':
    unittest.main()
