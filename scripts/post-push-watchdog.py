#!/usr/bin/env python3
"""macOS post-push verify supervisor; diagnostics never count as verify progress."""
import argparse
import concurrent.futures
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time


def capture(path, command, timeout=10):
    """Every probe has a deadline and a durable result, including tool errors."""
    with path.open('w') as output:
        output.write('$ ' + ' '.join(command) + '\n')
        output.flush()
        try:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT,
                                    timeout=timeout)
            output.write(f'\nexit={result.returncode}\n')
        except (OSError, subprocess.TimeoutExpired) as error:
            output.write(f'\nprobe error: {error}\n')


def diagnose(directory, root, lock):
    directory.mkdir(parents=True, exist_ok=True)
    snapshot = subprocess.check_output(
        ['ps', '-axo', 'pid,ppid,pgid,stat,etime,pcpu,rss,command'], text=True, timeout=10)
    rows = [line.split(None, 7) for line in snapshot.splitlines()[1:]]
    descendants = {root}
    while True:
        added = {int(row[0]) for row in rows if int(row[1]) in descendants}
        if added <= descendants:
            break
        descendants |= added
    selected = [row for row in rows if int(row[0]) in descendants or int(row[2]) == root]
    (directory / 'processes.txt').write_text(snapshot.splitlines()[0] + '\n' +
                                           '\n'.join(' '.join(row) for row in selected) + '\n')
    # Concurrent probes prevent many compiler children from delaying the 10-minute kill.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = []
        jobs.append(pool.submit(capture, directory / 'host.txt', ['sh', '-c',
            'uptime; vm_stat; df -h "$PWD" /tmp; bun --version; '
            'echo "Bun cache locks (mtime and age in seconds):"; '
            'find "$HOME/.bun/install/cache" -iname "*lock*" -exec stat -f "%m %N" {} + '
            '| awk -v now="$(date +%s)" \'{print $0, "age=" now-$1}\'']))
        jobs.append(pool.submit(capture, directory / 'verify-lock.txt', ['sh', '-c',
            'echo "Lock: $1; own verify session: $2"; '
            'if lockf -t 0 "$1" true; then echo "lock free"; '
            'else echo "lock held (compare holder PID with processes.txt)"; fi; '
            'lsof "$1"', 'sh', str(lock), str(root)]))
        for row in selected:
            if any(name in row[7].lower() for name in ('bun', 'tsc', 'node')):
                pid = row[0]
                jobs.append(pool.submit(capture, directory / f'sample-{pid}.txt',
                                        ['sample', pid, '5', '-file', str(directory / f'stack-{pid}.txt')], 8))
                jobs.append(pool.submit(capture, directory / f'lsof-{pid}.txt', ['lsof', '-p', pid], 8))
        for job in jobs:
            job.result()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--diagnose-after', type=float, default=480)
    parser.add_argument('--fail-after', type=float, default=600)
    parser.add_argument('--wall-timeout', type=float, default=2700)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not 0 < args.diagnose_after < args.fail_after <= args.wall_timeout:
        parser.error('require command and 0 < diagnose-after < fail-after <= wall-timeout')
    args.artifacts = args.artifacts.resolve()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    acquired = args.artifacts / 'lock-acquired'
    acquired.unlink(missing_ok=True)
    if subprocess.run(['lockf', '-t', '0', str(args.lock), 'true']).returncode:
        print('verify lock held by another run; waiting', flush=True)
    process = subprocess.Popen(['lockf', str(args.lock), 'sh', '-c',
        'touch "$1"; shift; echo "$(date -u +%FT%TZ) verify lock acquired"; exec "$@"',
        'sh', str(acquired), *command], stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)

    def kill_group(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS can report EPERM for an already-reaped process group.
            if process.poll() is None:
                raise

    def cancel(_sig, _frame):
        print('run cancelled; dropping its verify unposted', flush=True)
        kill_group(signal.SIGKILL)
        process.wait()
        raise SystemExit(1)

    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    started = time.monotonic()
    progress = None
    captured_for = None
    termination = None
    failed = False
    # A separate diagnostic process keeps slow tools out of the supervision loop.
    probe = None
    probe_started = None
    printed = set()
    with (args.artifacts / 'verify.log').open('wb') as log:
        try:
            while process.poll() is None or selector.get_map():
                now = time.monotonic()
                if progress is None and acquired.exists():
                    progress = now
                for key, _ in selector.select(.2):
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                    log.write(data)
                    log.flush()
                    if progress is not None and b'\n' in data:
                        progress = time.monotonic()
                idle = now - progress if progress is not None else 0
                if idle >= args.diagnose_after and captured_for != progress and probe is None:
                    captured_for = progress
                    directory = args.artifacts / f'diagnostic-{time.time_ns()}'
                    print(f'STALL_CAPTURE: {idle:.0f}s without verify output; evidence={directory}', flush=True)
                    probe_started = now
                    probe = subprocess.Popen([sys.executable, __file__, 'capture', str(directory),
                                              str(process.pid), str(args.lock)], start_new_session=True)
                if probe is not None and probe.poll() is None and now - probe_started >= 60:
                    print('diagnostic collection reached its 60s budget', flush=True)
                    os.killpg(probe.pid, signal.SIGKILL)
                    probe.wait()
                # Publish only complete files, and never through the verify-output pipe.
                if probe is not None and probe.poll() is not None:
                    for path in sorted(args.artifacts.glob('diagnostic-*/*.txt')):
                        if path not in printed:
                            print(f'--- {path.name} ---\n{path.read_text(errors="replace")}', flush=True)
                            printed.add(path)
                    probe = None
                if termination is None and (idle >= args.fail_after or now - started >= args.wall_timeout):
                    marker = 'STALL_DIAGNOSED' if idle >= args.fail_after else 'VERIFY_WALL_TIMEOUT'
                    print(f'{marker}: idle={idle:.0f}s; terminating verify session {process.pid}', flush=True)
                    failed = True
                    termination = now
                    kill_group(signal.SIGTERM)
                if termination is not None and now - termination >= 10:
                    kill_group(signal.SIGKILL)
                    break
            process.wait(timeout=5)
        finally:
            kill_group(signal.SIGKILL)
            if probe is not None:
                # Do not let evidence collection outlive the job indefinitely.
                try:
                    probe.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(probe.pid, signal.SIGKILL)
                    probe.wait()
            for path in sorted(args.artifacts.glob('diagnostic-*/*.txt')):
                if path not in printed:
                    print(f'--- {path.name} ---\n{path.read_text(errors="replace")}', flush=True)
            selector.close()
            process.stdout.close()
    return 124 if failed else (process.returncode if process.returncode >= 0 else 128 - process.returncode)


if __name__ == '__main__':
    if sys.argv[1:2] == ['capture']:
        diagnose(Path(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4]))
    else:
        sys.exit(main())
