"""Ported from policy/__tests__/target-drive-concurrency.test.ts: the
controller admits at most four target drives at once, and a waiting
non-periodic drive is admitted ahead of queued periodic maintenance."""
import asyncio
import unittest

from mail_delivery.act_controller import create_mail_kicker
from mail_delivery.act_internal import MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES


class _MailDelivery:
    def resolve_birth_refusal(self, *_args):
        return False


class _Store:
    mail_delivery = _MailDelivery()


def target(name):
    return f'agent:cody:project:agent-control-plane:task:{name}/lane:main'


def kicker_with(port):
    return create_mail_kicker(dict(store=_Store(), port=port, ledger=object(), node_id='max3',
                                   foreign_home_memo={}, log=lambda *_: None),
                              dict(enabled=True, sweep_interval_ms=60_000))


class TargetDriveConcurrency(unittest.IsolatedAsyncioTestCase):
    async def test_does_not_admit_a_fifth_hrc_lookup_until_one_of_four_drives_releases(self):
        gate = asyncio.Event()
        counts = dict(active=0, maximum=0, entered=0)

        class Port:
            async def resolve_foreign_home(self, _scope_ref):
                counts['entered'] += 1
                counts['active'] += 1
                counts['maximum'] = max(counts['maximum'], counts['active'])
                await gate.wait()
                counts['active'] -= 1
                return dict(homeNodeId='svc', source='registry')

        kicker = kicker_with(Port())
        operations = []
        for index in range(12):
            ref = target(f'T-9{index:04}')
            kicker.mail_kicker_pending_targets[ref] = 'periodic'
            operations.append(kicker.drain_target(ref))
        await asyncio.sleep(0.01)
        self.assertEqual(counts['entered'], MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES)
        self.assertEqual(counts['maximum'], MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES)
        gate.set()
        await asyncio.gather(*operations)
        self.assertEqual(counts['entered'], 12)
        self.assertEqual(counts['maximum'], MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES)

    async def test_admits_newly_inserted_mail_ahead_of_queued_periodic_maintenance(self):
        state = dict(unblock=False)
        releases = []
        entered = []

        class Port:
            async def resolve_foreign_home(self, scope_ref):
                entered.append(scope_ref)
                if not state['unblock']:
                    release = asyncio.Event()
                    releases.append(release)
                    await release.wait()
                return dict(homeNodeId='svc', source='registry')

        kicker = kicker_with(Port())
        operations = []
        for index in range(MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES + 1):
            ref = target(f'T-periodic-{index}')
            kicker.mail_kicker_pending_targets[ref] = 'periodic'
            operations.append(kicker.drain_target(ref))
        await asyncio.sleep(0.01)
        inserted = target('T-insert')
        kicker.mail_kicker_pending_targets[inserted] = 'insert'
        operations.append(kicker.drain_target(inserted))
        state['unblock'] = True
        releases.pop(0).set()
        await asyncio.sleep(0.01)
        self.assertIn('T-insert', entered[MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES])
        for release in releases:
            release.set()
        await asyncio.gather(*operations)


if __name__ == '__main__':
    unittest.main()
