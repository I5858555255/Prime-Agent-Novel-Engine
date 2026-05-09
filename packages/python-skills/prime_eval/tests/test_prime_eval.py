from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

import prime_eval


class PrimeEvalTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_parses_json(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout='{"evaluations":[],"total":0}',
            stderr="",
        )

        with (
            patch("prime_eval.prime_eval.shutil.which", return_value="/bin/prime"),
            patch("prime_eval.prime_eval.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_eval.run(action="list", env_name="gsm8k", max_results=5)

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/bin/prime", "--plain", "eval", "list"])
        self.assertIn("--env", command)
        self.assertEqual(result["data"]["total"], 0)

    async def test_hosted_run_builds_access_flags(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout="created eval",
            stderr="",
        )

        with (
            patch("prime_eval.prime_eval.shutil.which", return_value="/bin/prime"),
            patch("prime_eval.prime_eval.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_eval.run(
                action="run",
                environment="primeintellect/wordle",
                model="openai/gpt-5.5",
                num_examples=2,
                allow_sandbox_access=True,
                allow_tunnel_access=True,
                eval_name="wordle smoke",
            )

        command = run.call_args.args[0]
        self.assertEqual(command[:5], ["/bin/prime", "--plain", "eval", "run", "primeintellect/wordle"])
        self.assertIn("--hosted", command)
        self.assertIn("--allow-sandbox-access", command)
        self.assertIn("--allow-tunnel-access", command)
        self.assertIn("--eval-name", command)
        self.assertIsNone(result["data"])

    async def test_run_requires_environment(self) -> None:
        with self.assertRaisesRegex(ValueError, "environment"):
            await prime_eval.run(action="run")


if __name__ == "__main__":
    unittest.main()
