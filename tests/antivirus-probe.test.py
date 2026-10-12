"""Resource and failure boundaries of the optional ClamAV capacity probe."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'services/web/vps/antivirus_probe.py'
spec = importlib.util.spec_from_file_location('antivirus_probe', source)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_low_headroom_and_active_ci_reject_before_start(self):
        for available, ci, expected in [(2200, False, 'HEADROOM'), (3100, True, 'CI_ACTIVE')]:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(probe.ProbeError, expected):
                    probe.require_headroom(available, ci, starting=True)
        probe.require_headroom(3100, False, starting=True)
        with self.assertRaisesRegex(probe.ProbeError, 'HEADROOM'):
            probe.require_headroom(700, False, starting=False)

    def test_clean_and_detection_both_required(self):
        good = '/fixtures/clean.txt: OK\n/fixtures/eicar.com: Win.Test.EICAR_HDB-1 FOUND\n'
        probe.verify_scan(1, good)
        for code, output in [(0, good), (1, '/fixtures/clean.txt: OK\n'),
                             (1, '/fixtures/eicar.com: Win.Test.EICAR_HDB-1 FOUND\n'),
                             (2, good), (1, good + 'ERROR: failed to load database\n')]:
            with self.subTest(code=code, output=output):
                with self.assertRaises(probe.ProbeError):
                    probe.verify_scan(code, output)

    def test_container_is_removed_after_failure_but_volume_is_retained(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[0] == 'create':
                return 'container-id'
            if args[0] == 'inspect':
                return '[{"Config":{"Labels":{"prizma.probe":"test-token"}}}]'
            return ''
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(probe, 'docker', side_effect=fake):
                with self.assertRaisesRegex(probe.ProbeError, 'INTERRUPTED'):
                    with probe.owned_container('test-token', 'scan', 'sha256:abc',
                            Path(directory), network='none'):
                        raise probe.ProbeError('INTERRUPTED')
        self.assertTrue(any(c[:2] == ['rm', '--force'] for c in calls))
        self.assertFalse(any(c[0] == 'volume' for c in calls))
        create = next(c for c in calls if c[0] == 'create')
        self.assertIn('--read-only', create)
        self.assertEqual(create[create.index('--memory') + 1], '1536m')
        self.assertEqual(create[create.index('--network') + 1], 'none')
        self.assertNotIn('--privileged', create)
        self.assertNotIn('--publish', create)

    def test_name_collision_never_removes_foreign_container(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[0] == 'create':
                raise probe.ProbeError('CREATE_FAILED')
            if args[0] == 'inspect':
                return '[{"Config":{"Labels":{"prizma.probe":"someone-else"}}}]'
            return ''
        with tempfile.TemporaryDirectory() as directory, patch.object(probe, 'docker', side_effect=fake):
            with self.assertRaisesRegex(probe.ProbeError, 'CREATE_FAILED'):
                with probe.owned_container('test-token', 'scan', 'sha256:abc', Path(directory), network='none'):
                    self.fail('foreign container was started')
        self.assertFalse(any(c[0] == 'rm' for c in calls))

    def test_update_failure_prevents_scan_and_no_probe_activates_worker(self):
        calls = []
        def failed(stage, *args, **kwargs):
            calls.append(stage)
            return (1, 'database update rejected', 100)
        with patch.object(probe, 'run_stage', side_effect=failed):
            with self.assertRaisesRegex(probe.ProbeError, 'UPDATE_FAILED'):
                probe.run_probe('test', 'sha256:abc', Path('/fixtures'))
        self.assertEqual(calls, ['update'])

    def test_oom_is_never_reported_as_success(self):
        with self.assertRaisesRegex(probe.ProbeError, 'MEMORY_LIMIT'):
            probe.completed_state({'Running':False, 'OOMKilled':True, 'ExitCode':1})
        self.assertEqual(probe.completed_state({'Running':False, 'OOMKilled':False, 'ExitCode':1}), 1)

    def test_host_pressure_during_running_stage_removes_only_probe(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[0] == 'create':
                return 'our-container-id'
            if args[0] == 'inspect':
                return '[{"Config":{"Labels":{"prizma.probe":"test-token"}}}]'
            return ''
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(probe, 'docker', side_effect=fake), patch.object(
                    probe, 'check_headroom', side_effect=[None, None, probe.ProbeError('HEADROOM_LOW')]):
                with self.assertRaisesRegex(probe.ProbeError, 'HEADROOM_LOW'):
                    probe.run_stage('scan', 'test-token', 'sha256:abc', Path(directory))
        self.assertTrue(any(c[0] == 'start' for c in calls))
        removed = next(c for c in calls if c[0] == 'rm')
        self.assertEqual(removed[-1], 'our-container-id')

    def test_probe_success_is_explicitly_not_production_or_combined_load(self):
        outputs = [(0, 'database tested', 1300), (1,
            '/fixtures/clean.txt: OK\n/fixtures/eicar.com: Win.Test.EICAR_HDB-1 FOUND\n', 1400)]
        with patch.object(probe, 'run_stage', side_effect=outputs) as stages, patch.object(probe, 'check_headroom'):
            result = probe.run_probe('token', 'sha256:abc', Path('/fixtures'))
        self.assertEqual([call.args[0] for call in stages.call_args_list], ['update', 'scan'])
        self.assertEqual(result['scanPeakMiB'], 1400)
        self.assertIs(result['applicationEnabled'], False)
        self.assertIs(result['combinedModelLoadTested'], False)

    def test_cleanup_after_creation_does_not_require_inspection(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[0] == 'create':
                return 'our-container-id'
            if args[0] == 'inspect':
                raise probe.ProbeError('DAEMON_BUSY')
            return ''
        with tempfile.TemporaryDirectory() as directory, patch.object(probe, 'docker', side_effect=fake):
            with self.assertRaisesRegex(probe.ProbeError, 'HEADROOM_LOW'):
                with probe.owned_container('token', 'scan', 'image', Path(directory), network='none'):
                    raise probe.ProbeError('HEADROOM_LOW')
        self.assertIn(['rm', '--force', 'our-container-id'], calls)

    def test_pull_aborted_for_host_pressure_terminates_cli(self):
        from unittest.mock import Mock
        process = Mock()
        process.poll.return_value = None
        process.communicate.return_value = ('', None)
        with patch.object(probe.subprocess, 'Popen', return_value=process), patch.object(
                probe, 'check_headroom', side_effect=probe.ProbeError('CI_ACTIVE')):
            with self.assertRaisesRegex(probe.ProbeError, 'CI_ACTIVE'):
                probe.pull_image()
        process.terminate.assert_called_once()


if __name__ == '__main__':
    unittest.main()
