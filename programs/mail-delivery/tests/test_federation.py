"""Mirrors drive/target-driver.ts launchHereOrSkip, facts/hrc-facts.ts (T-12214)."""
from tests.common import *


class Federation(Rules):
    def test_foreign_home_or_live_elsewhere_skips(self):
        self.check('skip', 'foreign_home', s=seat(home='foreign'))
        self.check('skip', 'live_elsewhere', s=seat(home='unbound', live_elsewhere=True))

    def test_unavailable_home_defers_but_incomplete_inventory_does_not_block_birth(self):
        self.check('defer', 'federation_unavailable', s=seat(home='unavailable'))
        self.check('launch', 'summoning_mail', s=seat(home='unbound', state='absent',
                                                        session_exists=False, federation_complete=False))

    def test_unknown_home_never_assumed_local(self):
        self.check('cannot_decide', s=seat(home=None), missing_fact='seat.home')
