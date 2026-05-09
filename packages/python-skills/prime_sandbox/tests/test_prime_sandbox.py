from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

import prime_sandbox


class PrimeSandboxTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_builds_json_command(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout='{"sandboxes":[],"total":0}',
            stderr="",
        )

        with (
            patch("prime_sandbox.prime_sandbox.shutil.which", return_value="/bin/prime"),
            patch("prime_sandbox.prime_sandbox.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_sandbox.run(action="list", labels=["agent"], max_results=5)

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/bin/prime", "--plain", "sandbox", "list"])
        self.assertIn("--label", command)
        self.assertIn("--output", command)
        self.assertEqual(result["data"]["total"], 0)

    async def test_run_builds_command_separator(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout="Python 3.12",
            stderr="",
        )

        with (
            patch("prime_sandbox.prime_sandbox.shutil.which", return_value="/bin/prime"),
            patch("prime_sandbox.prime_sandbox.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_sandbox.run(
                action="run",
                sandbox_id="sb_123",
                command=["python", "--version"],
            )

        command = run.call_args.args[0]
        self.assertEqual(
            command,
            [
                "/bin/prime",
                "--plain",
                "sandbox",
                "run",
                "sb_123",
                "--",
                "python",
                "--version",
            ],
        )
        self.assertIsNone(result["data"])

    async def test_delete_requires_scope(self) -> None:
        with self.assertRaisesRegex(ValueError, "delete"):
            await prime_sandbox.run(action="delete")


if __name__ == "__main__":
    unittest.main()
