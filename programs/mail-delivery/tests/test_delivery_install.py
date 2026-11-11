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
            (source / 'program.json').write_text(json.dumps(dict(name='mail-delivery', module='mail_delivery.main', project='agent-control-plane')))
            protocol = checkout / 'node_modules/@wrkq/client/dist/protocol.js'
            protocol.parent.mkdir(parents=True)
            protocol.write_text('export const PROTOCOL_VERSION = "1";\nexport const PROTOCOL_SCHEMA_HASH = "sha256:' + 'a'*64 + '";\n')
            target = root / 'programs/mail-delivery'
            install(source, target, checkout, commit='test-commit')
            self.assertEqual((target / 'mail_delivery/main.py').read_text(), '# acting entry')
            self.assertIn("ACP_COMMIT = 'test-commit'", (target / 'mail_delivery/build_info.py').read_text())
            self.assertIn('sha256:' + 'a'*64, (target / 'mail_delivery/wrkq_pin.py').read_text())
            (source / 'program.json').write_text(json.dumps(dict(name='mail-delivery', module='mail_delivery.shadow', project='agent-control-plane')))
            with self.assertRaises(ValueError):
                install(source, target, checkout, commit='bad')
            self.assertIn('test-commit', (target / 'mail_delivery/build_info.py').read_text())
