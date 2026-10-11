"""Failure-path tests for the shared-host Nginx installer (standard library only)."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

source = Path(__file__).resolve().parents[1] / 'services/web/vps/proxy.py'
spec = importlib.util.spec_from_file_location('prizma_proxy', source)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.target = self.directory / 'prizma.conf'
        self.other = self.directory / 'vpn.conf'
        self.other.write_bytes(b'original VPN configuration')
        self.events = []

    def invoke(self, check=None, verify=None, reload=None):
        return proxy.install(self.target, b'prizma configuration\n',
            preflight=lambda: self.events.append('preflight'),
            check=check or (lambda: self.events.append('check')),
            reload=reload or (lambda: self.events.append('reload')),
            verify=verify or (lambda: self.events.append('verify')))

    def test_install_checks_then_reloads_and_preserves_other_sites(self):
        self.invoke()
        self.assertEqual(self.events, ['preflight', 'check', 'reload', 'verify'])
        self.assertEqual(self.target.read_bytes(), b'prizma configuration\n')
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.other.read_bytes(), b'original VPN configuration')

    def test_invalid_configuration_is_removed_without_reloading(self):
        def invalid():
            raise proxy.SetupError('CONFIG_INVALID')
        with self.assertRaisesRegex(proxy.SetupError, 'CONFIG_INVALID'):
            self.invoke(check=invalid)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.events, ['preflight'])
        self.assertEqual(self.other.read_bytes(), b'original VPN configuration')

    def test_tls_or_backend_failure_rolls_back_and_reloads_original(self):
        def failed():
            raise proxy.SetupError('TLS_INVALID')
        with self.assertRaisesRegex(proxy.SetupError, 'TLS_INVALID'):
            self.invoke(verify=failed)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.events, ['preflight', 'check', 'reload', 'check', 'reload'])
        self.assertEqual(self.other.read_bytes(), b'original VPN configuration')

    def test_unexpected_file_and_symlink_are_never_overwritten(self):
        self.target.write_bytes(b'someone else owns this')
        with self.assertRaisesRegex(proxy.SetupError, 'CONFIG_EXISTS'):
            self.invoke()
        self.assertEqual(self.target.read_bytes(), b'someone else owns this')
        self.target.unlink()
        self.target.symlink_to(self.other)
        with self.assertRaisesRegex(proxy.SetupError, 'CONFIG_EXISTS'):
            self.invoke()
        self.assertEqual(self.other.read_bytes(), b'original VPN configuration')
        self.assertEqual(self.events, [])

    def test_existing_identical_install_is_verified_without_reload_or_deletion(self):
        self.invoke()
        self.events.clear()
        def failed():
            raise proxy.SetupError('TLS_INVALID')
        with self.assertRaisesRegex(proxy.SetupError, 'TLS_INVALID'):
            self.invoke(verify=failed)
        self.assertEqual(self.events, ['preflight', 'check'])
        self.assertEqual(self.target.read_bytes(), b'prizma configuration\n')

    def test_failed_preflight_makes_no_changes(self):
        def failed():
            raise proxy.SetupError('BACKEND_UNAVAILABLE')
        with self.assertRaisesRegex(proxy.SetupError, 'BACKEND_UNAVAILABLE'):
            proxy.install(self.target, b'new', preflight=failed,
                check=lambda: self.fail('check called'),
                reload=lambda: self.fail('reload called'),
                verify=lambda: self.fail('verify called'))
        self.assertFalse(self.target.exists())

    def test_termination_after_publication_or_during_verification_rolls_back(self):
        for stage, signum in [('published', signal.SIGHUP), ('verify', signal.SIGTERM)]:
            with self.subTest(stage=stage):
                marker = self.directory / 'ready'
                marker.unlink(missing_ok=True)
                self.target.unlink(missing_ok=True)
                child = r'''
import importlib.util, os, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location('proxy', sys.argv[1])
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
target, marker, stage = Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
proxy.TARGET, proxy.DIRECTORY = target, target.parent
(target.parent / 'prizma-8443.conf').write_bytes(b'prizma configuration\n')
original_open = os.open
def file_open(path, *args, **kwargs):
    if str(path) == '/run/lock/prizma-https.lock':
        path = target.parent / 'setup.lock'
    return original_open(path, *args, **kwargs)
proxy.os.open = file_open
proxy.os.geteuid = lambda: 0
proxy.preflight = lambda: None
proxy.command = lambda *args: None
def pause():
    marker.write_text('ready')
    time.sleep(0.6)
if stage == 'published':
    original = os.link
    def link(*args, **kwargs):
        original(*args, **kwargs)
        pause()
    proxy.os.link = link
proxy.verify = pause if stage == 'verify' else lambda: None
try:
    proxy.main()
except proxy.SetupError as error:
    sys.exit(23 if str(error) == 'INTERRUPTED' else 24)
sys.exit(25)
'''
                process = subprocess.Popen([sys.executable, '-c', child, str(source),
                    str(self.target), str(marker), stage], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 3
                    while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    if not marker.exists():
                        _, errors = process.communicate(timeout=3)
                        self.fail('child did not reach target stage: ' + errors.decode())
                    os.kill(process.pid, signum)
                    _, errors = process.communicate(timeout=3)
                    self.assertEqual(process.returncode, 23, errors.decode())
                    self.assertFalse(self.target.exists())
                    self.assertEqual(self.other.read_bytes(), b'original VPN configuration')
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate()


if __name__ == '__main__':
    unittest.main()
