"""Process-level checks. Run on macOS (real lockf/sample/lsof), no services.
Failure modes: false silence while waiting for lock; output/exit-code changes;
diagnostics feeding the progress timer; diagnostic tools hanging; resumed output;
orphaned children on cancellation; lost evidence on failure.
"""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name('post-push-watchdog.py')


@unittest.skipUnless(sys.platform == 'darwin', 'requires macOS lockf')
class Watchdog(unittest.TestCase):
    def run_probe(self, code, expected, diagnose=1, fail=2):
        with tempfile.TemporaryDirectory() as directory:
            args = [sys.executable, str(SCRIPT), '--lock', directory + '/lock',
                    '--artifacts', directory + '/evidence', '--diagnose-after', str(diagnose),
                    '--fail-after', str(fail), '--', sys.executable, '-u', '-c', code]
            result = subprocess.run(args, capture_output=True, timeout=30)
            output = result.stdout.decode()
            self.assertEqual(result.returncode, expected, result.stderr.decode() + output)
            files = list(Path(directory, 'evidence').glob('**/*'))
            return output, [p.name for p in files]

    def test_healthy_output_and_exit_status(self):
        output, files = self.run_probe("import time; [(print('progress'), time.sleep(.3)) for _ in range(10)]", 0)
        self.assertEqual(output.count('progress'), 10)
        self.assertNotIn('STALL_', output)
        self.assertNotIn('processes.txt', files)
        self.run_probe('raise SystemExit(7)', 7)

    def test_silent_process_fails_and_preserves_evidence(self):
        output, files = self.run_probe('import time; time.sleep(60)', 124)
        self.assertIn('STALL_DIAGNOSED', output)
        self.assertIn('processes.txt', files)
        self.assertIn('host.txt', files)
        self.assertIn('verify.log', files)

    def test_output_resumes_after_capture(self):
        output, _ = self.run_probe("import time; time.sleep(1.4); print('resumed'); time.sleep(.8)", 0)
        self.assertIn('STALL_CAPTURE', output)
        self.assertNotIn('STALL_DIAGNOSED', output)

    def test_lock_wait_does_not_count_as_silence(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = directory + '/lock'
            holder = subprocess.Popen(['lockf', lock, 'sleep', '3'])
            try:
                time.sleep(.2)
                result = subprocess.run([sys.executable, str(SCRIPT), '--lock', lock,
                    '--artifacts', directory + '/evidence', '--diagnose-after', '.5',
                    '--fail-after', '1', '--', 'true'], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn(b'STALL_', result.stdout)
            finally:
                holder.wait()

    def test_cancellation_kills_session(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory, 'pid')
            code = f"import os,time; open({str(pidfile)!r},'w').write(str(os.getpid())); time.sleep(60)"
            process = subprocess.Popen([sys.executable, str(SCRIPT), '--lock', directory + '/lock',
                '--artifacts', directory + '/evidence', '--', sys.executable, '-c', code],
                stdout=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 5
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertTrue(pidfile.exists())
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=5)
                time.sleep(.2)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pidfile.read_text()), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    unittest.main()
