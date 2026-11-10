"""Mirrors drive/target-driver.ts birthForTarget and t12977-terminal-task-fyi."""
from tests.common import *


class WhoIsWoken(Rules):
    def test_summons_birth_with_or_without_session(self):
        for obligation in ('notify', 'reply_required'):
            for exists in (True, False):
                self.check('launch', e=envelope(obligation=obligation),
                           s=seat(session_exists=exists, state='absent'))

    def test_fyi_never_mints_session(self):
        self.check('hold', 'fyi_no_session', e=envelope(obligation='fyi'),
                   s=seat(session_exists=False, state='absent'))

    def test_fyi_existing_session_enqueues_and_may_birth_runtime(self):
        self.check('enqueue', e=envelope(obligation='fyi'), s=seat(state='absent'))

    def test_finished_task_fyi_closes_without_notice(self):
        for state in ('completed', 'cancelled', 'archived', 'deleted'):
            self.check('fail', 'target_task_terminal', e=envelope(obligation='fyi'),
                       s=seat(state='absent', target_is_task=True, task_read='ok', task_state=state),
                       effects=())

    def test_task_read_failure_falls_back_but_missing_read_is_unknown(self):
        self.check('enqueue', e=envelope(obligation='fyi'),
                   s=seat(state='absent', target_is_task=True, task_read='failed'))
        self.check('cannot_decide', e=envelope(obligation='fyi'),
                   s=seat(state='absent', target_is_task=True, task_read=None),
                   missing_fact='seat.task_read')

    def test_session_fact_missing(self):
        self.check('cannot_decide', s=seat(session_exists=None), missing_fact='seat.session_exists')
