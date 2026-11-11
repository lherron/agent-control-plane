"""Node settings come from the injector plist, never ambient kernel HRC vars."""
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

from mail_delivery.node_config import load_node_config, state_path


class NodeConfig(unittest.TestCase):
    def test_applies_only_hrc_and_path_and_requires_wrkq(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'injector.plist'
            values = dict(HRC_WRKQ_DB='rpc://scratch:7171', HRC_WRKQD_TOKEN_FILE='/scratch/token',
                          HRC_MAIL_INJECTOR_STATE_PATH='/scratch/injector.sqlite', PATH='/scratch/bin',
                          OTHER='do not import')
            path.write_bytes(plistlib.dumps({'EnvironmentVariables': values}))
            with patch.dict(os.environ, {}, clear=True):
                self.assertTrue(load_node_config(path))
                self.assertEqual(os.environ['HRC_WRKQ_DB'], values['HRC_WRKQ_DB'])
                self.assertEqual(os.environ['PATH'], '/scratch/bin')
                self.assertNotIn('OTHER', os.environ)
                self.assertEqual(state_path(path), Path('/scratch/injector.sqlite'))
            path.write_bytes(plistlib.dumps({'EnvironmentVariables': {'PATH': '/scratch/bin'}}))
            self.assertFalse(load_node_config(path))
            self.assertFalse(load_node_config(path.with_name('missing')))
