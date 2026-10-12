"""One-shot, isolated ClamAV capacity check. Never activates the application scanner."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

IMAGE = 'clamav/clamav:1.4.6'
VOLUME = 'prizma_clamav_probe_db'
LABEL = 'prizma.probe'
LIMIT_MIB = 1536
FLOOR_MIB = 768
DIRECTORY = Path(__file__).resolve().parent
cancelled = False


class ProbeError(Exception):
    pass


def require_headroom(available_mib, ci_active, *, starting):
    if cancelled:
        raise ProbeError('INTERRUPTED')
    if ci_active:
        raise ProbeError('CI_ACTIVE')
    required = FLOOR_MIB + (LIMIT_MIB if starting else 0)
    if available_mib < required:
        raise ProbeError('HEADROOM_LOW')


def verify_scan(code, output):
    if (code != 1 or '/fixtures/clean.txt: OK' not in output.splitlines()
            or not re.search(r'^/fixtures/eicar\.com: [^\r\n]*Eicar[^\r\n]* FOUND$', output, re.M | re.I)
            or 'ERROR' in output):
        raise ProbeError('SCAN_SELF_TEST_FAILED')


def docker(args, *, timeout=30, check=True):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode and not check and re.search(r'No such (object|container|volume)', result.stderr, re.I):
        return '[]'
    if result.returncode:
        raise ProbeError('DOCKER_' + args[0].upper() + '_FAILED: ' + result.stderr[-1200:].strip())
    return result.stdout


def pull_image():
    process = subprocess.Popen(['docker', 'pull', IMAGE], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True)
    deadline = time.monotonic() + 600
    progress = time.monotonic() + 20
    try:
        while True:
            check_headroom(starting=True)
            if time.monotonic() > deadline:
                raise ProbeError('PULL_TIMEOUT')
            try:
                output, _ = process.communicate(timeout=0.5)
                if process.returncode:
                    raise ProbeError('PULL_FAILED: ' + output[-1500:])
                check_headroom(starting=True)
                return
            except subprocess.TimeoutExpired:
                if time.monotonic() > progress:
                    print('CLAM_PROBE_PULL_WAIT', flush=True)
                    progress = time.monotonic() + 20
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)


def host_state():
    match = re.search(r'^MemAvailable:\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M)
    if not match:
        raise ProbeError('MEMORY_UNREADABLE')
    active = False
    for path in Path('/proc').glob('[0-9]*/comm'):
        try:
            if path.read_text().strip() == 'Runner.Worker':
                active = True
        except FileNotFoundError:
            pass  # Process finished between enumeration and read.
    return int(match[1]) // 1024, active


def check_headroom(*, starting=False):
    require_headroom(*host_state(), starting=starting)


def completed_state(state):
    if state.get('OOMKilled') or state.get('ExitCode') == 137:
        raise ProbeError('MEMORY_LIMIT_REACHED')
    return None if state['Running'] else state['ExitCode']


def phase_command(stage):
    if stage == 'update':
        command = 'freshclam --config-file=/fixtures/freshclam.conf --stdout'
    elif stage == 'scan':
        command = ('clamscan --database=/var/lib/clamav --stdout --no-summary '
                   '--max-filesize=8M --max-scansize=32M --max-recursion=8 '
                   '--max-files=1000 --max-scantime=10000 --alert-exceeds-max=yes '
                   '/fixtures/clean.txt /fixtures/eicar.com')
    else:
        raise ProbeError('UNKNOWN_STAGE')
    # Require cgroup v2 peak accounting. Report the whole container, including DB testing.
    return ('test -r /sys/fs/cgroup/memory.peak || exit 70; ' + command +
            '; result=$?; printf "PRIZMA_PEAK_BYTES="; cat /sys/fs/cgroup/memory.peak; exit "$result"')


@contextmanager
def owned_container(token, stage, image, fixtures, *, network):
    name = 'prizma-clam-probe-' + token + '-' + stage
    created_id = None
    try:
        created_id = docker(['create', '--name', name, '--label', LABEL + '=' + token,
                '--pull', 'never', '--user', 'clamav', '--read-only', '--init',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--memory', str(LIMIT_MIB) + 'm', '--memory-swap', str(LIMIT_MIB) + 'm',
                '--cpus', '0.5', '--cpu-shares', '128', '--pids-limit', '64',
                '--network', network, '--no-healthcheck', '--restart', 'no',
                '--log-opt', 'max-size=5m', '--log-opt', 'max-file=1',
                '--tmpfs', '/tmp:size=64M,noexec,nosuid,mode=1777',
                '--mount', 'type=volume,src=' + VOLUME + ',dst=/var/lib/clamav' +
                (',readonly' if stage == 'scan' else ''),
                '--mount', 'type=bind,src=' + str(fixtures) + ',dst=/fixtures,readonly',
                '--entrypoint', '/bin/sh', image, '-c', phase_command(stage)]).strip()
        yield name
    finally:
        try:
            if created_id:
                # A successfully created immutable ID is ours; cleanup must not depend
                # on another metadata read succeeding while the host is under pressure.
                docker(['rm', '--force', created_id])
            else:
                found = json.loads(docker(['inspect', name], check=False) or '[]')
                if found and (found[0].get('Config', {}).get('Labels') or {}).get(LABEL) == token:
                    docker(['rm', '--force', name])
        except (ProbeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            raise ProbeError('CLEANUP_FAILED container=' + name + ': ' + str(error)) from error


def run_stage(stage, token, image, fixtures):
    check_headroom(starting=True)
    print('CLAM_PROBE_' + stage.upper(), flush=True)
    with owned_container(token, stage, image, fixtures,
                         network='bridge' if stage == 'update' else 'none') as name:
        check_headroom(starting=True)
        docker(['start', name])
        deadline = time.monotonic() + (1200 if stage == 'update' else 300)
        progress = time.monotonic() + 20
        while True:
            check_headroom()
            state = json.loads(docker(['inspect', '--format', '{{json .State}}', name], timeout=5))
            code = completed_state(state)
            if code is not None:
                output = docker(['logs', name])
                peak = re.search(r'^PRIZMA_PEAK_BYTES=(\d+)$', output, re.M)
                if not peak:
                    raise ProbeError('PEAK_UNAVAILABLE: ' + output[-1500:])
                return code, output, (int(peak[1]) + 1048575) // 1048576
            if time.monotonic() > deadline:
                raise ProbeError('PROBE_TIMEOUT')
            if time.monotonic() > progress:
                print('CLAM_PROBE_WAIT stage=' + stage, flush=True)
                progress = time.monotonic() + 20
            time.sleep(0.5)


def run_probe(token, image, fixtures):
    code, output, update_peak = run_stage('update', token, image, fixtures)
    if code:
        raise ProbeError('UPDATE_FAILED: ' + output[-1500:])
    code, output, scan_peak = run_stage('scan', token, image, fixtures)
    verify_scan(code, output)
    check_headroom()
    return {'status': 'CLAM_PROBE_OK', 'image': image, 'updatePeakMiB': update_peak,
            'scanPeakMiB': scan_peak, 'limitMiB': LIMIT_MIB, 'applicationEnabled': False,
            'combinedModelLoadTested': False}


def prepare_fixtures(directory):
    # EICAR is a harmless antivirus test string, never executed or exposed publicly.
    (directory / 'clean.txt').write_text('Prizma benign scanner readiness test\n')
    (directory / 'eicar.com').write_bytes(
        b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
    (directory / 'freshclam.conf').write_text(
        'DatabaseDirectory /var/lib/clamav\nDatabaseOwner clamav\n'
        'DatabaseMirror database.clamav.net\nDNSDatabaseInfo current.cvd.clamav.net\n'
        'TestDatabases yes\nScriptedUpdates yes\nConnectTimeout 15\n'
        'ReceiveTimeout 60\nMaxAttempts 1\n')
    directory.chmod(0o755)
    for path in directory.iterdir():
        path.chmod(0o644)


def main():
    if os.geteuid() != 0:
        raise ProbeError('ROOT_REQUIRED')
    lock = os.open('/run/lock/prizma-clam-probe.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def interrupted(signum, frame):
            global cancelled
            cancelled = True
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, interrupted)
        check_headroom(starting=True)
        root = Path(docker(['info', '--format', '{{.DockerRootDir}}']).strip())
        if not root.is_absolute() or shutil.disk_usage(root).free < 2 * 1024**3:
            raise ProbeError('DISK_HEADROOM_LOW')
        print('CLAM_PROBE_PULL ' + IMAGE, flush=True)
        pull_image()
        image = docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]).strip()
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
            raise ProbeError('IMAGE_ID_INVALID')
        check_headroom(starting=True)
        volume = json.loads(docker(['volume', 'inspect', VOLUME], check=False) or '[]')
        if volume:
            if (volume[0].get('Labels') or {}).get(LABEL) != 'database':
                raise ProbeError('DATABASE_VOLUME_OWNED_ELSEWHERE')
        else:
            docker(['volume', 'create', '--label', LABEL + '=database', VOLUME])
        # Temp fixtures are removed; the official downloaded database is retained for reuse.
        with tempfile.TemporaryDirectory(prefix='prizma-clam-probe-') as path:
            fixtures = Path(path)
            prepare_fixtures(fixtures)
            result = run_probe(uuid.uuid4().hex, image, fixtures)
        print(json.dumps(result), flush=True)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except (ProbeError, OSError, subprocess.TimeoutExpired, ValueError) as error:
        print(json.dumps({'status':'CLAM_PROBE_STOPPED', 'reason':str(error),
                          'applicationEnabled':False}), flush=True)
        raise SystemExit(1)
