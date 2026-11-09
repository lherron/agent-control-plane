#!/usr/bin/env python3
"""Launch HRC's FakeAspd and scratch execution release; no vendored substrate."""
import argparse
import json
from pathlib import Path
import shutil
import signal
import sys
import threading

parser = argparse.ArgumentParser()
parser.add_argument('--checkout', type=Path, required=True)
parser.add_argument('--root', type=Path, required=True)
args = parser.parse_args()
e2e = args.checkout / 'crates/hrc-native/e2e'
for name in ('hrcpty_substrate.py', 'hrcpty_stub_broker.py'):
    if not (e2e / name).is_file():
        raise SystemExit(f'timeline acceptance requires HRC checkout substrate: {e2e / name}')
for name in ('hrcpty-true-response.json', 'hrcpty-false-response.json', 'after-true-response.json'):
    template = e2e / 'fixtures/aspc-codex' / name
    if not template.is_file():
        raise SystemExit(f'timeline acceptance requires self-contained HRC FakeAspd fixture: {template}')
sys.path.insert(0, str(e2e))
from hrcpty_substrate import FakeAspd  # noqa: E402

release_root = args.root / 'release'
(release_root / 'bin').mkdir(parents=True)
# This scratch copy is the producer substrate's designed release layout. Keep
# it here so it can go away when the producer accepts an explicit config path.
stub = release_root / 'bin/stub-broker'
shutil.copyfile(e2e / 'hrcpty_stub_broker.py', stub)
stub.chmod(0o755)
identity = {'releaseId': 'acp-timeline-stub', 'sourceCommit': '1' * 40,
            'builtAt': '2026-11-09T00:00:00.000Z'}
drivers = ['claude-code-hrcpty', 'claude-code-tmux', 'codex-app-server']
(release_root / 'release.json').write_text(json.dumps({**identity, 'protocol': 'harness-broker/0.2',
                                                       'hostedDrivers': drivers}))
release = {**identity, 'releaseRoot': str(release_root),
           'worker': {'protocol': 'harness-broker/0.2', 'executable': str(stub),
                      'argvPrefix': [], 'hostedDrivers': drivers}}
aspd = FakeAspd(args.root / 'aspd.sock', release, args.root / 'fake-aspd.ndjson')
stop = threading.Event()
for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, lambda *_: stop.set())
print('ready', flush=True)
stop.wait()
aspd.close()
