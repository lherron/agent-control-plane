"""Recipient hint style from the profile's declared base spaces
(policy/__tests__/recipient-membership.test.ts)."""
import os
import tempfile
import unittest

from mail_delivery.presentation_text import RecipientHints


class RecipientMembershipTests(unittest.TestCase):
    def setUp(self):
        self.dirs = []

    def tearDown(self):
        for directory in self.dirs:
            directory.cleanup()

    def setup(self, content):
        root = tempfile.TemporaryDirectory()
        self.dirs.append(root)
        os.mkdir(os.path.join(root.name, 'any-agent'))
        path = os.path.join(root.name, 'any-agent', 'agent-profile.toml')
        with open(path, 'w') as handle:
            handle.write(content)
        logs = []
        hints = RecipientHints(lambda _level, _event, detail: logs.append(detail), lambda _project=None: [root.name])
        return dict(path=path, logs=logs, hints=hints, style=lambda: hints.for_recipient('any-agent', None))

    def test_uses_only_declared_base_spaces_and_accepts_any_selector_without_name_matching(self):
        for ref in ('space:prae-tools@dev', 'space:prae-tools@1.2.3'):
            self.assertEqual(self.setup(f'[spaces]\nbase = ["{ref}"]')['style'](), 'prae')
        for content in ('', '[spaces]\nbase = ["space:other@dev"]', '[spaces]\nextra = ["space:prae-tools@dev"]',
                        '[spaces]\nbase = [42, "not a ref"]'):
            self.assertEqual(self.setup(content)['style'](), 'legacy')

    def test_caches_the_decision_by_profile_stat_logs_the_hash_once_and_invalidates_on_change(self):
        fixture = self.setup('[spaces]\nbase = ["space:prae-tools@dev"]')
        self.assertEqual(fixture['style'](), 'prae')
        self.assertEqual(fixture['style'](), 'prae')
        self.assertEqual(len(fixture['logs']), 1)
        self.assertRegex(fixture['logs'][0]['contentHash'], r'^[a-f0-9]{64}$')
        with open(fixture['path'], 'w') as handle:
            handle.write('[spaces]\nbase = []')
        self.assertEqual(fixture['style'](), 'legacy')
        self.assertEqual(len(fixture['logs']), 2)

    def test_falls_back_and_logs_on_malformed_missing_or_unreadable_roots_recovers_after_repair(self):
        fixture = self.setup('[spaces')
        self.assertEqual(fixture['style'](), 'legacy')
        self.assertIsNotNone(fixture['logs'][0].get('reason'))
        with open(fixture['path'], 'w') as handle:
            handle.write('[spaces]\nbase = ["space:prae-tools@dev"]')
        self.assertEqual(fixture['style'](), 'prae')
        os.remove(fixture['path'])
        self.assertEqual(fixture['style'](), 'legacy')

        def no_root(_project=None):
            raise Exception('no root')
        self.assertEqual(RecipientHints(lambda *_: None, no_root).for_recipient('any-agent'), 'legacy')

    def test_honors_root_precedence_and_isolates_per_agent_profile_paths(self):
        first = self.setup('')
        second = self.setup('[spaces]\nbase = ["space:prae-tools@dev"]')
        roots = [os.path.normpath(os.path.join(first['path'], '../..')),
                 os.path.normpath(os.path.join(second['path'], '../..'))]
        hints = RecipientHints(lambda *_: None, lambda _project=None: roots)
        self.assertEqual(hints.for_recipient('any-agent'), 'legacy')
        self.assertEqual(hints.for_recipient('missing'), 'legacy')


if __name__ == '__main__':
    unittest.main()
