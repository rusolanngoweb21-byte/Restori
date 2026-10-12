"""Deployment control-flow tests with a Docker test double; not image validation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class BuildTests(unittest.TestCase):
    def run_manage(self, action, fail_smoke=False, bundle=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            helper = root / "services/web/vps/manage"
            helper.parent.mkdir(parents=True)
            shutil.copy(Path(__file__).resolve().parents[1] / "services/web/vps/manage", helper)
            bindir = root / "bin"
            bindir.mkdir()
            docker = bindir / "docker"
            docker.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
with open(os.environ["PRIZMA_DOCKER_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["image", "inspect"]:
    sys.exit(0 if os.environ.get("PRIZMA_TEST_BUNDLE") == "1" else 1)
if sys.argv[1] == "run" and os.environ.get("PRIZMA_TEST_SMOKE_FAIL") == "1":
    sys.exit(17)
''')
            docker.chmod(0o755)
            log = root / "calls.jsonl"
            result = subprocess.run(["sh", str(helper), action], text=True, capture_output=True,
                env={**os.environ, "PATH": str(bindir) + os.pathsep + os.environ["PATH"],
                     "PRIZMA_DOCKER_LOG": str(log), "PRIZMA_TEST_BUNDLE": "1" if bundle else "0",
                     "PRIZMA_TEST_SMOKE_FAIL": "1" if fail_smoke else "0"})
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            return result, calls

    def test_failed_inference_cannot_promote_or_start_candidate(self):
        result, calls = self.run_manage("build-multilingual", fail_smoke=True)
        self.assertEqual(result.returncode, 17)
        self.assertFalse(any(c[0] in ["tag", "compose"] for c in calls))
        self.assertNotIn("MULTILINGUAL_BUILD_OK", result.stdout)

    def test_successful_inference_precedes_promotion_without_service_restart(self):
        result, calls = self.run_manage("build-multilingual")
        self.assertEqual(result.returncode, 0, result.stderr)
        run_index = next(i for i, c in enumerate(calls) if c[0] == "run")
        smoke = calls[run_index]
        self.assertIn("none", smoke)
        self.assertIn("1536m", smoke)
        self.assertIn("PRIZMA_EXPECT_LANGUAGES=en,ru", smoke)
        promotions = [i for i, c in enumerate(calls) if c[0] == "tag"]
        self.assertEqual(len(promotions), 2)
        self.assertTrue(all(i > run_index for i in promotions))
        self.assertFalse(any(c[0] == "compose" for c in calls))

    def test_routine_build_retains_installed_language_bundle_offline(self):
        for bundle, expected in [(False, "prizma-analyzer:local"), (True, "prizma-models:multilingual")]:
            with self.subTest(bundle=bundle):
                result, calls = self.run_manage("build", bundle=bundle)
                self.assertEqual(result.returncode, 0)
                build = next(c for c in calls if c[0] == "build")
                self.assertIn("MODEL_IMAGE=" + expected, build)
                self.assertIn("none", build)


if __name__ == "__main__":
    unittest.main()
