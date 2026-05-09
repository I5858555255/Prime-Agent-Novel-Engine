from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

import prime_envs


class PrimeEnvsTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_builds_json_command(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout='{"environments":[],"total":0}',
            stderr="",
        )

        with (
            patch("prime_envs.prime_envs.shutil.which", return_value="/bin/prime"),
            patch("prime_envs.prime_envs.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_envs.run(
                action="list",
                search="math",
                max_results=3,
                tags=["openenv"],
            )

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/bin/prime", "--plain", "env", "list"])
        self.assertIn("--output", command)
        self.assertIn("json", command)
        self.assertIn("--search", command)
        self.assertEqual(result["data"]["total"], 0)

    async def test_install_requires_env_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "env_ids"):
            await prime_envs.run(action="install")

    async def test_pull_builds_target_and_version(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout="pulled",
            stderr="",
        )

        with (
            patch("prime_envs.prime_envs.shutil.which", return_value="/bin/prime"),
            patch("prime_envs.prime_envs.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_envs.run(
                action="pull",
                env_id="owner/name",
                version="1.2.3",
                target="./env",
            )

        command = run.call_args.args[0]
        self.assertEqual(
            command,
            [
                "/bin/prime",
                "--plain",
                "env",
                "pull",
                "owner/name",
                "--version",
                "1.2.3",
                "--target",
                "./env",
            ],
        )
        self.assertIsNone(result["data"])


if __name__ == "__main__":
    unittest.main()
