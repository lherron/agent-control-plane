#!/usr/bin/env python3
"""Owner-operated LaunchAgent lifecycle; existing host configurations are retained."""
import argparse
import os
import pathlib
import plistlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
JOBS = ('acp-server', 'hrc-viewer', 'log-rotation')


def render(source, home, agents):
    data = plistlib.loads(source.read_bytes())
    replacements = {'__HOME__': str(home), '/Users/lherron': str(home)}
    if '__WRKQ_DB__' in source.read_text() or '__WRKQD_TOKEN_FILE__' in source.read_text():
        hrc = plistlib.loads((agents / 'com.praesidium.hrc-server.plist').read_bytes())
        env = hrc['EnvironmentVariables']
        for token, key in [('__WRKQ_DB__', 'HRC_WRKQ_DB'), ('__WRKQD_TOKEN_FILE__', 'HRC_WRKQD_TOKEN_FILE')]:
            if not env.get(key):
                raise ValueError(f'installed HRC plist declares no {key}')
            replacements[token] = env[key]

    def expand(value):
        if isinstance(value, str):
            for token, replacement in replacements.items():
                value = value.replace(token, replacement)
            return value
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        return value

    return expand(data)


def loaded(target):
    return subprocess.run(['launchctl', 'print', target], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0


def unload(target):
    if not loaded(target):
        return
    subprocess.run(['launchctl', 'bootout', target], check=True)
    # bootout returns before removal; preserve the viewer's existing race fix.
    for _ in range(50):
        if not loaded(target):
            return
        time.sleep(0.2)
    raise RuntimeError(f'{target} is still loaded after bootout')


def lifecycle(action, jobs):
    home = pathlib.Path.home()
    agents = home / 'Library/LaunchAgents'
    domain = f'gui/{os.getuid()}'
    for job in jobs:
        label = f'com.praesidium.{job}'
        dst = agents / f'{label}.plist'
        target = f'{domain}/{label}'
        if action == 'uninstall':
            unload(target)
            dst.unlink(missing_ok=True)
            print(f'[launchd] removed {target}')
            continue
        agents.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            data = render(ROOT / 'launchd' / dst.name, home, agents)
            # Write a complete validated plist before making it visible to launchd.
            with tempfile.NamedTemporaryFile(dir=agents, delete=False) as handle:
                pending = pathlib.Path(handle.name)
                plistlib.dump(data, handle)
            try:
                pending.chmod(0o644)
                pending.replace(dst)
            finally:
                pending.unlink(missing_ok=True)
        # Installed plists on max3 and svc carry host settings. Never overwrite
        # them from repo templates; adoption is the only in-place patch here.
        data = plistlib.loads(dst.read_bytes())
        for key in ('StandardOutPath', 'StandardErrorPath'):
            if key in data:
                pathlib.Path(data[key]).parent.mkdir(parents=True, exist_ok=True)
        # svc has no shim/adopter: source plists already invoke the plain binary.
        adopter = shutil.which('praesidium-adopt')
        if adopter:
            subprocess.run([adopter, str(dst)], check=True)
        unload(target)
        for attempt in range(5):
            if subprocess.run(['launchctl', 'bootstrap', domain, str(dst)]).returncode == 0:
                break
            if attempt == 4:
                raise RuntimeError(f'could not bootstrap {target} after 5 attempts')
            time.sleep(1)
        # A successful bootstrap must also be visible to launchd.
        subprocess.run(['launchctl', 'print', target], check=True, stdout=subprocess.DEVNULL)
        print(f'[launchd] activated {target}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'uninstall'))
    parser.add_argument('jobs', nargs='*')
    args = parser.parse_args()
    if any(job not in JOBS for job in args.jobs):
        parser.error(f'jobs must be one of: {", ".join(JOBS)}')
    lifecycle(args.action, args.jobs or JOBS)
