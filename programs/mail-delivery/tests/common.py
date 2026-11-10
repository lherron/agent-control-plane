from dataclasses import replace
from unittest import TestCase
from mail_delivery.decision import Envelope, Seat, Runtime, Intent, Presentation, Retry, Refusal, decide

NOW = 10_000_000


def envelope(**changes):
    return replace(Envelope(
        id='EN-test', obligation='reply_required', state='pending',
        created_at=NOW - 100, delivery='normal', presented_before=False,
        intent=Intent(status='none'), presentation=Presentation(status='none'),
        birth_retry=Retry(kind='none'), steer_refusal=Refusal(kind='none'),
        non_landing_strikes=0, kind='envelope',
    ), **changes)


def seat(**changes):
    return replace(Seat(
        home='local', live_elsewhere=False, federation_complete=True,
        session_exists=True, state='idle', steer_capable=True,
        steer_capability_refused=False, awaiting_input=False,
        quiet_hold=False, target_is_task=False, task_read='not_applicable',
    ), **changes)


def runtime(**changes):
    return replace(Runtime(id='rt-test', status='live', created_at=NOW - 1000), **changes)


class Rules(TestCase):
    def check(self, action, reason=None, e=None, s=None, r=None, now=NOW, **expected):
        result = decide(e or envelope(), s or seat(), r or runtime(), now)
        self.assertEqual(result.action, action, result)
        if reason is not None:
            self.assertEqual(result.reason, reason)
        for key, value in expected.items():
            self.assertEqual(getattr(result, key), value, result)
        return result
