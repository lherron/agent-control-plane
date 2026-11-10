"""Mirrors launch-recovery.ts, wake/birth-retry.ts, landing.ts, failure-notices.ts."""
from tests.common import *
from mail_delivery.timings import participant_host_retry_ms, failure_notice_retry_ms, steer_retry_ms


class GivingUp(Rules):
    def test_strikes(self):
        self.check('fail', 'non_landing_strikes', e=envelope(non_landing_strikes=3))
        self.check('steer', e=envelope(non_landing_strikes=2))

    def test_launch_and_sweep_bounds(self):
        for kind, attempts in (('launch', 3), ('sweep', 5), ('not_hosted', 5), ('deterministic', 1)):
            self.check('fail', 'undeliverable', e=envelope(birth_retry=Retry(kind=kind, attempts=attempts, host_reason='ordinary')))
        self.check('defer', 'birth_backoff',
                   e=envelope(birth_retry=Retry(kind='launch', attempts=1, last_at=NOW, host_reason='ordinary')), retry_at=NOW+60_000)
        self.check('defer', e=envelope(birth_retry=Retry(kind='not_hosted', attempts=1, last_at=NOW, host_reason='ordinary')),
                   retry_at=NOW+900_000)

    def test_participant_host_elapsed_bound(self):
        for reason in ('host_absent', 'participant_attempt_absorbing', 'participant_substitution',
                       'participant_attachment_pending', 'participant_activation_pending',
                       'participant_reconnect_in_progress', 'participant_runtime_not_materialized',
                       'participant_reconnecting'):
            retry = Retry(kind='launch', attempts=20, last_at=NOW, host_reason=reason, host_since=NOW-599_999)
            self.check('defer', e=envelope(birth_retry=retry), retry_at=NOW+60_000)
            self.check('fail', e=envelope(birth_retry=replace(retry, host_since=NOW-600_000)))
        for reason in ('participant_reconnect_exhausted', 'participant_linkage_stale'):
            self.check('fail', e=envelope(birth_retry=Retry(kind='launch', attempts=3, host_reason=reason)))

    def test_participant_only_complete_inventory(self):
        self.check('fail', e=envelope(birth_retry=Retry(kind='participant_only')))
        self.check('defer', e=envelope(birth_retry=Retry(kind='participant_only', attempts=1, last_at=NOW, host_reason='ordinary')),
                   s=seat(federation_complete=False))

    def test_notice_never_births_and_only_reply_required(self):
        for obligation in ('fyi', 'notify'):
            self.check('hold', 'notice_not_owed', e=envelope(kind='failure_notice', obligation=obligation))
        self.check('hold', 'notice_no_live_seat', e=envelope(kind='failure_notice'), s=seat(state='absent'))
        self.check('enqueue', 'failure_notice', e=envelope(kind='failure_notice', notice_attempts=0,
                                                        notice_parked=False))
        self.check('hold', 'notice_exhausted', e=envelope(kind='failure_notice', notice_attempts=8))
        self.check('hold', 'notice_parked', e=envelope(kind='failure_notice', notice_attempts=1,
                                                    notice_parked=True))
        self.check('defer', e=envelope(kind='failure_notice', notice_attempts=2, notice_parked=False,
                                      notice_last_at=NOW), retry_at=NOW+30_000)

    def test_retry_tables(self):
        self.assertEqual([participant_host_retry_ms(n) for n in range(1,6)], [10000,20000,40000,60000,60000])
        self.assertEqual([failure_notice_retry_ms(n) for n in range(1,4)], [0,30000,60000])
        self.assertEqual(failure_notice_retry_ms(20), 3_600_000)
        self.assertEqual([steer_retry_ms(n) for n in range(1,7)], [2000,4000,8000,16000,30000,30000])

    def test_missing_refusal_class_not_assumed_ordinary(self):
        self.check('cannot_decide', e=envelope(birth_retry=Retry(kind='launch', attempts=3)),
                   missing_fact='birth_retry.host_reason')

    def test_participant_turn_retry_has_no_persisted_launch_giveup_clock(self):
        self.check('defer', 'birth_backoff', e=envelope(birth_retry=Retry(kind='participant_turn',
                   attempts=100, last_at=NOW, host_reason='host_absent')), retry_at=NOW+60_000)
