#!/usr/bin/env python3
"""Exercise lifecycle commands with scratch HOME and fake launchctl, never launchd."""
import json
import os
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts/launchd-jobs.py'


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = pathlib.Path(self.temp.name) / 'home & node'
        self.agents = self.home / 'Library/LaunchAgents'
        self.agents.mkdir(parents=True)
        self.bin = pathlib.Path(self.temp.name) / 'bin'
        self.bin.mkdir()
        (self.bin / 'python3').symlink_to(sys.executable)
        self.trace = pathlib.Path(self.temp.name) / 'trace'
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{self.bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', TRACE=str(self.trace))
        self.executable('launchctl', '''#!/usr/bin/env python3
import json,os,pathlib,sys
p=pathlib.Path(os.environ['TRACE'])
with p.open('a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
state=p.parent / sys.argv[-1].split('/')[-1].replace('.plist','')
if sys.argv[1]=='print': sys.exit(0 if state.exists() or os.environ.get('LOADED') else 1)
if sys.argv[1]=='bootout':
 if os.environ.get('FAIL_BOOTOUT'): sys.exit(5)
 state.unlink(missing_ok=True)
if sys.argv[1]=='bootstrap':
 if os.environ.get('FAIL_BOOTSTRAP'): sys.exit(5)
 state.touch()
''')
        hrc = {'EnvironmentVariables': {'HRC_WRKQ_DB': '/real/db & path', 'HRC_WRKQD_TOKEN_FILE': '/real/token'}}
        (self.agents / 'com.praesidium.hrc-server.plist').write_bytes(plistlib.dumps(hrc))

    def executable(self, name, text):
        p = self.bin / name
        p.write_text(text)
        p.chmod(0o755)

    def run_lifecycle(self, *args, success=True):
        recipes = {('install',): 'launchd-install', ('uninstall',): 'launchd-uninstall',
                   ('install', 'hrc-viewer'): 'install-hrc-viewer-launchd',
                   ('install', 'log-rotation'): 'install-log-rotation'}
        command = ['just', '--justfile', str(ROOT / 'justfile'), recipes[args]] if args in recipes else ['python3', str(SCRIPT), *args]
        result = subprocess.run(command, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def calls(self):
        return [json.loads(s) for s in self.trace.read_text().splitlines()] if self.trace.exists() else []

    def test_plain_install_preserves_existing_and_uninstalls_only_owned(self):
        existing = self.agents / 'com.praesidium.acp-server.plist'
        host = {'Label': 'com.praesidium.acp-server', 'ProgramArguments': ['/custom/acp'], 'EnvironmentVariables': {'NODE': 'svc'}}
        existing.write_bytes(plistlib.dumps(host))
        for _ in range(2):
            self.run_lifecycle('install')
            self.assertEqual(plistlib.loads(existing.read_bytes()), host)
        viewer = plistlib.loads((self.agents / 'com.praesidium.hrc-viewer.plist').read_bytes())
        self.assertEqual(viewer['EnvironmentVariables']['WRKQ_DB'], '/real/db & path')
        self.assertEqual(viewer['EnvironmentVariables']['WRKQD_TOKEN_FILE'], '/real/token')
        self.assertEqual(viewer['ProgramArguments'], [str(self.home / '.bun/bin/hrc-viewer')])
        self.assertNotIn('AssociatedBundleIdentifiers', viewer)
        self.run_lifecycle('uninstall')
        self.run_lifecycle('uninstall')
        self.assertTrue((self.agents / 'com.praesidium.hrc-server.plist').exists())
        self.assertFalse(existing.exists())

    def test_adopt_before_bootstrap_and_preserve_config(self):
        self.executable('praesidium-adopt', '''#!/usr/bin/env python3
import json,os,pathlib,plistlib,sys
p=pathlib.Path(sys.argv[1]); d=plistlib.loads(p.read_bytes())
d['AssociatedBundleIdentifiers']=['com.praesidium.AgentHost']
shim=os.environ['HOME']+'/.local/bin/praesidium-launch'
if d['ProgramArguments'][0]!=shim: d['ProgramArguments'].insert(0,shim)
p.write_bytes(plistlib.dumps(d))
with open(os.environ['TRACE'],'a') as f: f.write(json.dumps(['adopt',str(p)])+'\\n')
''')
        self.run_lifecycle('install', 'hrc-viewer')
        self.run_lifecycle('install', 'hrc-viewer')
        path = self.agents / 'com.praesidium.hrc-viewer.plist'
        d = plistlib.loads(path.read_bytes())
        self.assertEqual(d['ProgramArguments'], [str(self.home / '.local/bin/praesidium-launch'), str(self.home / '.bun/bin/hrc-viewer')])
        calls = self.calls()
        self.assertEqual(calls[0][0], 'adopt')
        self.assertEqual(sum(c[0] == 'bootstrap' for c in calls), 2)

    def test_missing_viewer_credentials_refuses_before_write(self):
        (self.agents / 'com.praesidium.hrc-server.plist').unlink()
        self.run_lifecycle('install', 'hrc-viewer', success=False)
        self.assertFalse((self.agents / 'com.praesidium.hrc-viewer.plist').exists())
        self.assertEqual(self.calls(), [])

    def test_adopter_failure_prevents_activation(self):
        self.executable('praesidium-adopt', '#!/bin/sh\nexit 9\n')
        self.run_lifecycle('install', 'log-rotation', success=False)
        self.assertEqual(self.calls(), [])

    def test_bootout_failure_preserves_installed_copy(self):
        self.run_lifecycle('install', 'log-rotation')
        self.env.update(LOADED='1', FAIL_BOOTOUT='1')
        self.run_lifecycle('uninstall', 'log-rotation', success=False)
        self.assertTrue((self.agents / 'com.praesidium.log-rotation.plist').exists())

    def test_bootstrap_failure_retries_and_refuses_success(self):
        self.env['FAIL_BOOTSTRAP'] = '1'
        self.run_lifecycle('install', 'log-rotation', success=False)
        self.assertEqual(sum(c[0] == 'bootstrap' for c in self.calls()), 5)

    def test_invalid_input_refuses_before_mutation(self):
        self.run_lifecycle('install', 'foreign', success=False)
        self.run_lifecycle('invalid', success=False)
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()
