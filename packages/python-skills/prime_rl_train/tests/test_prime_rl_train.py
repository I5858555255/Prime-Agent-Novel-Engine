from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

import prime_rl_train


class PrimeRlTrainTests(unittest.IsolatedAsyncioTestCase):
    async def test_models_parses_json(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout='{"models":[{"name":"openai/gpt-oss"}]}',
            stderr="",
        )

        with (
            patch("prime_rl_train.prime_rl_train.shutil.which", return_value="/bin/prime"),
            patch(
                "prime_rl_train.prime_rl_train.subprocess.run",
                return_value=completed,
            ) as run,
        ):
            result = await prime_rl_train.run(action="models")

        command = run.call_args.args[0]
        self.assertEqual(command, ["/bin/prime", "--plain", "train", "models", "--output", "json"])
        self.assertEqual(result["data"]["models"][0]["name"], "openai/gpt-oss")

    async def test_run_builds_launch_command(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout="created",
            stderr="",
        )

        with (
            patch("prime_rl_train.prime_rl_train.shutil.which", return_value="/bin/prime"),
            patch(
                "prime_rl_train.prime_rl_train.subprocess.run",
                return_value=completed,
            ) as run,
        ):
            result = await prime_rl_train.run(
                action="run",
                config_path="rl.toml",
                env_vars=["PRIME_API_KEY"],
                yes=True,
            )

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/bin/prime", "--plain", "train", "rl.toml"])
        self.assertIn("--env-var", command)
        self.assertIn("PRIME_API_KEY", command)
        self.assertIn("--yes", command)
        self.assertIsNone(result["data"])

    async def test_rollouts_requires_step(self) -> None:
        with self.assertRaisesRegex(ValueError, "step"):
            await prime_rl_train.run(action="rollouts", run_id="rft_123")


if __name__ == "__main__":
    unittest.main()
