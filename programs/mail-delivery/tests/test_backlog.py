"""Mirrors drive/presentation.ts isBacklogFyi and t10159-backlog-fyi-digest."""
from tests.common import *


class Backlog(Rules):
    def test_age_strict_boundary(self):
        self.check('steer', e=envelope(obligation='fyi', created_at=NOW - 900_000),
                   r=runtime(created_at=0), form='full')
        self.check('steer', e=envelope(obligation='fyi', created_at=NOW - 900_001), form='digest')

    def test_predates_runtime_and_never_preempts(self):
        self.check('steer', e=envelope(obligation='fyi', created_at=NOW - 2000, delivery='hold'),
                   form='digest')

    def test_defer_retry_and_notify_are_not_digest(self):
        self.check('steer', e=envelope(obligation='fyi', created_at=0, presented_before=True),
                   form='defer-retry')
        self.check('steer', e=envelope(obligation='notify', created_at=0), form='full')

    def test_unknown_birth_falls_back_to_age_as_injector_does(self):
        self.check('steer', e=envelope(obligation='fyi'), r=runtime(created_at=None), form='full')

    def test_absent_fyi_age_still_digest(self):
        self.check('enqueue', e=envelope(obligation='fyi', created_at=0),
                   s=seat(state='absent'), r=runtime(created_at=None), form='digest')
