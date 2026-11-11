"""Stage a source install entirely in a temporary directory."""
import json
from pathlib import Path
import tempfile
import unittest

from mail_delivery.install import install


class Install(unittest.TestCase):
    def test_copies_acting_code_generates_provenance_and_refuses_shadow_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, checkout = root / 'source', root / 'checkout'
            source.mkdir()
            (source / 'mail_delivery').mkdir()
            (source / 'mail_delivery/main.py').write_text('# acting entry')
            (source / 'module.json').write_text(json.dumps(dict(name='mail-delivery', entry='mail_delivery.main', project='agent-control-plane')))
            protocol = checkout / 'node_modules/@wrkq/client/dist/protocol.js'
            protocol.parent.mkdir(parents=True)
            protocol.write_text('export const PROTOCOL_VERSION = "1";\nexport const PROTOCOL_SCHEMA_HASH = "sha256:' + 'a'*64 + '";\n')
            target = root / 'modules/mail-delivery'
            install(source, target, checkout, commit='test-commit')
            self.assertEqual((target / 'mail_delivery/main.py').read_text(), '# acting entry')
            self.assertIn("ACP_COMMIT = 'test-commit'", (target / 'mail_delivery/build_info.py').read_text())
            self.assertIn('sha256:' + 'a'*64, (target / 'mail_delivery/wrkq_pin.py').read_text())
            (source / 'module.json').write_text(json.dumps(dict(name='mail-delivery', entry='mail_delivery.shadow', project='agent-control-plane')))
            with self.assertRaises(ValueError):
                install(source, target, checkout, commit='bad')
            self.assertIn('test-commit', (target / 'mail_delivery/build_info.py').read_text())


class InstallWithoutCheckout(unittest.TestCase):
    """A satellite node has no git checkout: the recipe stages the sources there
    and names the commit, so the entry point must not ask git for it."""

    def test_named_commit_is_stamped_without_calling_git(self):
        from unittest import mock
        from mail_delivery import install as module
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)

            def no_git(*args, **kwargs):
                raise AssertionError('git was called')
            with mock.patch.object(module.Path, 'home', return_value=home), \
                    mock.patch.object(module.subprocess, 'check_output', no_git), \
                    mock.patch('builtins.print'):
                module.main(['--commit', 'c0ffee'])
            target = home / '.local/lib/praesidium-kernel/modules/mail-delivery'
            self.assertIn("ACP_COMMIT = 'c0ffee'", (target / 'mail_delivery/build_info.py').read_text())
            self.assertTrue((target / 'mail_delivery/main.py').is_file())
            self.assertEqual(json.loads((target / 'module.json').read_text())['entry'], 'mail_delivery.main')
            self.assertFalse((target / 'program.json').exists())


class KernelModulesLayout(unittest.TestCase):
    """The kernel reads only modules/<name>/module.json; the pre-rename
    programs/mail-delivery tree goes in the same install."""

    def run_main(self, home, argv):
        from unittest import mock
        from mail_delivery import install as module
        with mock.patch.object(module.Path, 'home', return_value=home), mock.patch('builtins.print'):
            module.main(argv)

    def test_install_removes_the_pre_rename_tree_and_uninstall_removes_both(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            lib = home / '.local/lib/praesidium-kernel'
            legacy = lib / 'programs/mail-delivery'
            (legacy / 'mail_delivery').mkdir(parents=True)
            (legacy / 'program.json').write_text('{}')
            self.run_main(home, ['--commit', 'c0ffee'])
            self.assertTrue((lib / 'modules/mail-delivery/module.json').is_file())
            self.assertFalse(legacy.exists())
            self.assertFalse((lib / 'programs').exists(), 'the emptied programs directory goes too')
            (legacy / 'mail_delivery').mkdir(parents=True)
            self.run_main(home, ['--uninstall'])
            self.assertFalse((lib / 'modules/mail-delivery').exists())
            self.assertFalse(legacy.exists())

    def test_another_program_keeps_the_programs_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            lib = home / '.local/lib/praesidium-kernel'
            (lib / 'programs/mail-delivery').mkdir(parents=True)
            (lib / 'programs/other').mkdir()
            self.run_main(home, ['--commit', 'c0ffee'])
            self.assertFalse((lib / 'programs/mail-delivery').exists())
            self.assertTrue((lib / 'programs/other').is_dir())
