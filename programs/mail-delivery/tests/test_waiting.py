"""Mirrors steer-hold.ts and wake/deferred.ts; t10233 and t12512."""
from tests.common import *


class Waiting(Rules):
    def test_not_ready_states(self):
        for state in ('starting', 'stopping', 'unavailable', 'turn-observed', 'terminal'):
            self.check('defer', s=seat(state=state))

    def test_awaiting_input_has_no_ceiling_and_only_holds_steer(self):
        self.check('hold', 'awaiting_input', s=seat(awaiting_input=True, quiet_since=0))
        self.check('enqueue', s=seat(awaiting_input=True, steer_capable=False))

    def test_quiet_hold_ceiling_and_activity(self):
        self.check('hold', 'pane_not_quiescent',
                   s=seat(quiet_hold=True, quiet_since=NOW - 599_999, quiet_moved=False))
        self.check('steer', s=seat(quiet_hold=True, quiet_since=NOW - 600_000, quiet_moved=False))
        self.check('steer', s=seat(quiet_hold=True, quiet_since=NOW, quiet_moved=True))

    def test_deferral_uses_wrkq_second_boundary_and_repend_confirmation(self):
        self.check('defer', 'recipient_deferred', e=envelope(state='deferred', retry_at=NOW + 1),
                   retry_at=NOW + 2000)
        self.check('defer', 'repend_required', e=envelope(state='deferred', retry_at=NOW - 5000, repend_attempts=0))
        self.check('cannot_decide', e=envelope(state='deferred'), missing_fact='envelope.retry_at')

    def test_missing_hold_fact(self):
        self.check('cannot_decide', s=seat(awaiting_input=None), missing_fact='seat.awaiting_input')

    def test_repend_confirmation_retries_one_two_five_seconds(self):
        for attempt, delay in ((1,1000), (2,2000), (3,5000), (20,5000)):
            self.check('defer', 'repend_backoff', e=envelope(state='deferred', retry_at=NOW-10_000,
                       repend_attempts=attempt, repend_last_at=NOW), retry_at=NOW+delay)
