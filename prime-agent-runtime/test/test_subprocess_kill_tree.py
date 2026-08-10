from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import rlm


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, OSError):
        return False
    except PermissionError:
        return True


class SubprocessKillTreeInstallTest(unittest.TestCase):
    """The kill-tree monkeypatch is installed on import and is idempotent."""

    def test_patch_installed(self) -> None:
        self.assertTrue(getattr(subprocess, "_prime_agent_kill_tree_patched", False))
        # subprocess.run must now be the patched wrapper, not the stdlib original.
        self.assertEqual(subprocess.run.__name__, "_run")

    def test_install_is_idempotent(self) -> None:
        original = subprocess.run
        rlm._install_subprocess_run_kill_tree()
        rlm._install_subprocess_run_kill_tree()
        self.assertIs(subprocess.run, original)

    def test_disable_env_flag(self) -> None:
        """PRIME_AGENT_DISABLE_SUBPROCESS_KILL_TREE=1 leaves subprocess.run untouched."""
        code = (
            "import os, subprocess; "
            "os.environ['PRIME_AGENT_DISABLE_SUBPROCESS_KILL_TREE'] = '1'; "
            "import rlm; "
            "print(getattr(subprocess, '_prime_agent_kill_tree_patched', False))"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "False")


class SubprocessRunBehaviorTest(unittest.TestCase):
    """The patched subprocess.run preserves normal semantics."""

    def test_normal_run_with_capture_output(self) -> None:
        result = subprocess.run(
            [sys.executable, "-c", "print('hello')"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "hello")

    def test_run_without_timeout_delegates(self) -> None:
        # timeout=None must keep the original code path (no behavior change).
        result = subprocess.run([sys.executable, "-c", "print('plain')"], capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), "plain")

    def test_check_true_raises_called_process_error(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as ctx:
            subprocess.run([sys.executable, "-c", "import sys; sys.exit(3)"], check=True, timeout=30)
        self.assertEqual(ctx.exception.returncode, 3)

    def test_input_and_timeout(self) -> None:
        result = subprocess.run(
            [sys.executable, "-c", "import sys; sys.stdout.write(sys.stdin.read().upper())"],
            input="abc",
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.stdout, "ABC")


class SubprocessKillTreeBehaviorTest(unittest.TestCase):
    """On TimeoutExpired the whole tree must die so a grandchild cannot hold the pipes."""

    def test_timeout_expired_kills_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            pidfile = os.path.join(temp_dir, "grandchild.pid")
            # Parent python process spawns a grandchild that sleeps and records
            # its pid, then the parent sleeps too -- both inherit the pipes of
            # subprocess.run(capture_output=True), which is exactly the Windows
            # hang scenario (child killed, grandchild keeps the pipe open).
            grandchild_code = (
                f"import time, os; open({pidfile!r}, 'w').write(str(os.getpid())); time.sleep(60)"
            )
            parent_code = (
                "import subprocess, sys, time; "
                f"p = subprocess.Popen([sys.executable, '-c', {grandchild_code!r}]); "
                "time.sleep(60)"
            )
            started = time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired):
                subprocess.run(
                    [sys.executable, "-c", parent_code],
                    capture_output=True,
                    timeout=2,
                )
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 15, f"TimeoutExpired took too long: {elapsed:.1f}s")

            # On Windows the grandchild must be dead (tree kill). On POSIX the
            # parent is in our process group, so only the direct child is killed
            # by design (killpg would take down the test process itself).
            if sys.platform == "win32":
                self.assertTrue(os.path.exists(pidfile), "grandchild never started")
                with open(pidfile, encoding="utf-8") as f:
                    grandchild_pid = int(f.read().strip())
                deadline = time.monotonic() + 5
                while _pid_alive(grandchild_pid) and time.monotonic() < deadline:
                    time.sleep(0.1)
                self.assertFalse(
                    _pid_alive(grandchild_pid),
                    "grandchild survived the kill-tree; it would hold the pipes forever",
                )


@unittest.skipUnless(hasattr(os, "getpgid"), "POSIX process groups required")
class SubprocessKillTreePosixBranchTest(unittest.TestCase):
    """The POSIX branch must never killpg our own process group."""

    def setUp(self) -> None:
        self.platform_patch = mock.patch("rlm.sys.platform", "linux")
        self.platform_patch.start()

    def tearDown(self) -> None:
        self.platform_patch.stop()

    def test_same_group_kills_only_pid(self) -> None:
        with (
            mock.patch("rlm.os.getpgid", side_effect=lambda pid: 100),
            mock.patch("rlm.os.killpg") as killpg,
            mock.patch("rlm.os.kill") as kill,
        ):
            rlm._subprocess_kill_tree(42)
        killpg.assert_not_called()
        kill.assert_called_with(42, 9)

    def test_different_group_kills_group(self) -> None:
        with (
            mock.patch("rlm.os.getpgid", side_effect=lambda pid: 100 if pid == 0 else 200),
            mock.patch("rlm.os.killpg") as killpg,
            mock.patch("rlm.os.kill") as kill,
        ):
            rlm._subprocess_kill_tree(42)
        killpg.assert_called_with(200, 9)
        kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
