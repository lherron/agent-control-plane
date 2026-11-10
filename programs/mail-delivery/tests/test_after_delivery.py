"""Mirrors terminal/disposal.ts, runtime-lapse.ts, wake/ledger-tail.ts, reconcile.ts."""
from tests.common import *


class AfterDelivery(Rules):
    def test_presented_legacy_mail_without_local_reminder_row_is_not_actionable(self):
        # drive/presentation.ts:readActionableEnvelopes subtracts presented
        # mail without a due reminder; EN-00738 live has no local presentation.
        self.check('hold', 'no_due_reminder', e=envelope(state='presented',
                   presentation=Presentation(status='none')))

    def presented(self, **kw):
        return envelope(state='presented', presented_before=True,
                        presentation=Presentation(status='landed', runtime_matches=True,
                                                  runtime_live=True, operator_held=False,
                                                  landing_seq=10, terminal_seq=20,
                                                  terminal_at=NOW, reminder='none', **kw))

    def test_reminder_armed_once_after_landed_turn(self):
        self.check('defer', 'reminder_wait', e=self.presented(), retry_at=NOW + 60_000,
                   effects=('arm_reminder',))
        e = self.presented()
        p = replace(e.presentation, reminder='armed', remind_at=NOW)
        self.check('steer', e=replace(e, presentation=p), form='reminder')
        p = replace(p, reminder='landed', reminder_landing_seq=15)
        self.check('hold', 'awaiting_operator', e=replace(e, presentation=p))
        p = replace(p, reminder_landing_seq=20)
        self.check('hold', 'reminder_pending', e=replace(e, presentation=p))

    def test_terminal_before_landing_not_second_strike(self):
        e = self.presented()
        self.check('hold', 'awaiting_turn', e=replace(e, presentation=replace(e.presentation, landing_seq=20)))

    def test_runtime_death_fails_except_operator_hold(self):
        e = self.presented()
        self.check('fail', 'runtime_terminated',
                   e=replace(e, presentation=replace(e.presentation, runtime_live=False)))
        self.check('hold', 'awaiting_operator', e=replace(e, presentation=replace(
            e.presentation, runtime_live=False, operator_held=True)))

    def test_terminal_queue_withdrawal_exceptions(self):
        i = Intent(status='open', door='enqueue', terminal_reason='replied',
                   cleanup_done=False, has_runtime=True, live_digest_siblings=False)
        self.check('hold', 'envelope_terminal', e=envelope(state='terminal', intent=i), effects=('withdraw',))
        for changes in ({'terminal_reason': 'fyi_presented'}, {'live_digest_siblings': True},
                        {'door': 'launch'}, {'cleanup_done': True}, {'has_runtime': False}):
            self.check('hold', e=envelope(state='terminal', intent=replace(i, **changes)), effects=())

    def test_ttl_and_stalled_keep_fence_no_redelivery(self):
        i = Intent(status='open', door='enqueue', submitted_at=NOW - 1_800_000, landing='none')
        self.check('hold', 'intent_open', e=envelope(intent=i), effects=('stalled', 'ttl_uncertain'))
        self.check('hold', 'intent_open', e=envelope(intent=replace(i, submitted_at=NOW - 300_000)),
                   effects=('stalled',))

    def test_missing_presentation_fact_is_named(self):
        e = self.presented()
        self.check('cannot_decide', e=replace(e, presentation=replace(e.presentation, runtime_live=None)),
                   missing_fact='presentation.runtime_live')

    def test_delayed_terminal_arms_from_observation_time(self):
        e = self.presented()
        self.check('defer', 'reminder_wait', e=replace(e, presentation=replace(e.presentation, terminal_at=0)),
                   retry_at=NOW + 60_000, effects=('arm_reminder',))

    def test_stalled_launch_without_live_scope_recovers_instead_of_just_logging(self):
        i = Intent(status='open', door='launch', submitted_at=NOW-300_000, landing='none',
                   scope_live=False, prior_launch_failures=0)
        self.check('defer', 'stalled_launch_recovery', e=envelope(intent=i),
                   retry_at=NOW+60_000, effects=('recover_launch',))
        self.check('fail', 'undeliverable', e=envelope(intent=replace(i, prior_launch_failures=2)),
                   effects=('recover_launch',))
        self.check('hold', 'intent_open', e=envelope(intent=replace(i, scope_live=True)),
                   effects=('stalled',))
