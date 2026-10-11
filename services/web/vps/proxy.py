"""Install the inspected VPS's isolated Prizma listener without editing other sites."""
from contextlib import contextmanager
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time

IP = '185.68.22.22'
AUTHORITY = IP + ':8443'
ORIGIN = 'https://' + AUTHORITY
DIRECTORY = Path(__file__).resolve().parent
TARGET = Path('/etc/nginx/conf.d/prizma-8443.conf')


class SetupError(Exception):
    pass


@contextmanager
def termination_guard():
    # Record signals immediately; raise only at safe transaction boundaries.
    # This covers publication and allows an in-progress rollback to finish.
    interrupted = False

    def receive(signum, frame):
        nonlocal interrupted
        interrupted = True

    def check_cancelled():
        if interrupted:
            raise SetupError('INTERRUPTED')

    previous = {signum: signal.signal(signum, receive)
                for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT)}
    try:
        yield check_cancelled
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def install(target, content, *, preflight, check, reload, verify, check_cancelled=lambda: None):
    """Publish one complete file exclusively; rollback only the file we created."""
    existing = target.exists() or target.is_symlink()
    if existing and (target.is_symlink() or not target.is_file() or target.read_bytes() != content):
        raise SetupError('CONFIG_EXISTS')
    preflight()
    check_cancelled()
    if existing:
        check()
        check_cancelled()
        verify()
        check_cancelled()
        return

    # A temporary file never matches conf.d/*.conf, even if writing is interrupted.
    with tempfile.NamedTemporaryFile(prefix='.prizma-', suffix='.tmp', dir=target.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            os.fchmod(output.fileno(), 0o644)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
            os.link(temporary, target)  # atomic creation, never replace an existing file
        finally:
            temporary.unlink()
    identity = target.stat()
    reload_attempted = False
    try:
        check_cancelled()
        check()
        check_cancelled()
        reload_attempted = True
        reload()
        check_cancelled()
        verify()
        check_cancelled()
    except BaseException:
        current = target.lstat()
        if (not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) !=
                (identity.st_dev, identity.st_ino) or target.read_bytes() != content):
            raise SetupError('ROLLBACK_REFUSED_CONFIG_CHANGED') from None
        target.unlink()
        if reload_attempted:
            try:
                check()
                reload()
            except Exception:
                raise SetupError('ROLLBACK_RELOAD_FAILED') from None
        raise


def command(arguments, failure):
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError(failure) from None
    if result.returncode:
        raise SetupError(failure)
    return result.stdout


def request(path, *, tls=False, host=AUTHORITY, method='GET'):
    connection = http.client.HTTPConnection('127.0.0.1', 8443 if tls else 18080, timeout=5)
    try:
        if tls:
            # Connect locally, but verify the public IP SAN and full system trust chain.
            connection.sock = ssl.create_default_context().wrap_socket(
                socket.create_connection(('127.0.0.1', 8443), timeout=5), server_hostname=IP)
        headers = {'Host': host, 'Connection': 'close'}
        if not tls:
            headers['X-Real-IP'] = '127.0.0.1'
        connection.request(method, path, body=b'{}' if method == 'POST' else None, headers=headers)
        response = connection.getresponse()
        body = response.read(65537)
        if len(body) > 65536:
            raise SetupError('PROBE_RESPONSE_TOO_LARGE')
        return response.status, body, response.getheader('Content-Type', '')
    finally:
        connection.close()


def capabilities(*, tls=False):
    status, body, _ = request('/api/capabilities', tls=tls)
    if status != 200:
        raise SetupError(('HTTPS' if tls else 'BACKEND') + '_HTTP_' + str(status))
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError):
        raise SetupError('CAPABILITIES_INVALID') from None
    if not isinstance(data, dict) or not isinstance(data.get('capabilities'), list) or not isinstance(data.get('reputation'), dict):
        raise SetupError('CAPABILITIES_INVALID')


def preflight():
    values = (DIRECTORY / '.private/web.env').read_text().splitlines()
    if values.count('PUBLIC_ORIGIN=' + ORIGIN) != 1 or sum(v.startswith('PUBLIC_ORIGIN=') for v in values) != 1:
        raise SetupError('ORIGIN_MISMATCH')
    configuration = command(['nginx', '-T'], 'EXISTING_NGINX_CONFIG_INVALID')
    if not re.search(r'^\s*include\s+/etc/nginx/conf\.d/\*\.conf\s*;', configuration, re.M):
        raise SetupError('CONF_D_NOT_INCLUDED')
    # Our inspected host has no real-IP rewrites. Refuse changed trust until reviewed.
    if re.search(r'^\s*(real_ip_header|set_real_ip_from|real_ip_recursive)\s+', configuration, re.M):
        raise SetupError('PROXY_TRUST_REQUIRES_REVIEW')
    if not TARGET.exists():
        try:
            with socket.socket() as listener:
                listener.bind(('0.0.0.0', 8443))
        except OSError:
            raise SetupError('PORT_8443_BUSY') from None
    command(['openssl', 'x509', '-in', '/etc/letsencrypt/live/' + IP + '/fullchain.pem',
             '-noout', '-checkend', '3600'], 'CERTIFICATE_EXPIRED_OR_UNREADABLE')
    capabilities()


def verify():
    deadline = time.monotonic() + 15
    while True:
        try:
            capabilities(tls=True)
            status, _, media_type = request('/', tls=True)
            if status != 200 or not media_type.startswith('text/html'):
                raise SetupError('HTTPS_PAGE_INVALID')
            if request('/api/capabilities', tls=True, host='invalid.example')[0] != 421:
                raise SetupError('HOST_GUARD_INVALID')
            if request('/api/internal/claim', tls=True, method='POST')[0] != 404:
                raise SetupError('PRIVATE_API_EXPOSED')
            return
        except (OSError, http.client.HTTPException, SetupError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


def main():
    if os.geteuid() != 0:
        raise SetupError('ROOT_REQUIRED')
    descriptor = os.open('/run/lock/prizma-https.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('SETUP_ALREADY_RUNNING') from None
        with termination_guard() as check_cancelled:
            install(TARGET, (DIRECTORY / 'prizma-8443.conf').read_bytes(), preflight=preflight,
                    check=lambda: command(['nginx', '-t'], 'NGINX_CONFIG_INVALID'),
                    reload=lambda: command(['nginx', '-s', 'reload'], 'NGINX_RELOAD_FAILED'),
                    verify=verify, check_cancelled=check_cancelled)
    print('HTTPS_LOCAL_OK ' + ORIGIN)
    print('CERTIFICATE_CHAIN_OK HOST_GUARD_OK PRIVATE_API_BLOCKED')


if __name__ == '__main__':
    try:
        main()
    except (SetupError, OSError, http.client.HTTPException) as error:
        reason = str(error) if isinstance(error, SetupError) else type(error).__name__
        print('HTTPS_SETUP_FAILED: ' + reason, file=sys.stderr)
        sys.exit(1)
