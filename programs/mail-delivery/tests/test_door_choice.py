"""Mirrors drive/delivery.ts doorFor, landing.ts steerRefusalFallback (T-08533)."""
from tests.common import *


class DoorChoice(Rules):
    def test_capability_required_for_idle_and_active(self):
        for state in ('idle', 'turn-active'):
            self.check('steer', s=seat(state=state))
            self.check('enqueue', s=seat(state=state, steer_capable=False))
            self.check('enqueue', s=seat(state=state, steer_capability_refused=True))

    def test_hold_is_envelope_delivery_not_seat_state(self):
        self.check('preempt', e=envelope(delivery='hold'), s=seat(preempt_admission='authorized'))
        for admission in ('denied', 'preempt-unsupported'):
            self.check('steer', 'hold_refused_authority', e=envelope(delivery='hold'),
                       s=seat(preempt_admission=admission))
        self.check('cannot_decide', e=envelope(delivery='hold'),
                   missing_fact='seat.preempt_admission')

    def test_refusal_fallback_and_transient_backoff(self):
        for kind in ('capability', 'policy', 'authority'):
            self.check('enqueue', e=envelope(steer_refusal=Refusal(kind=kind)))
        self.check('defer', 'steer_backoff',
                   e=envelope(steer_refusal=Refusal(kind='transient', attempts=1, last_at=NOW)),
                   retry_at=NOW + 2000)
        self.check('steer', e=envelope(steer_refusal=Refusal(kind='transient', attempts=9,
                                                          last_at=NOW - 30_000)))

    def test_unknown_capability_never_guessed(self):
        self.check('cannot_decide', s=seat(steer_capable=None), missing_fact='seat.steer_capable')

    def test_absent_existing_session_fyi_still_asks_hold_admission(self):
        self.check('preempt', e=envelope(obligation='fyi', delivery='hold'),
                   s=seat(state='absent', preempt_admission='authorized'))
