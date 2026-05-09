from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

import prime_hub


class PrimeHubTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_builds_search_command_and_parses_json(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout='{"environments":[{"environment":"primeintellect/wordle"}],"total":1}',
            stderr="",
        )

        with (
            patch("prime_hub.prime_hub.shutil.which", return_value="/bin/prime"),
            patch("prime_hub.prime_hub.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_hub.run(
                query="wordle",
                max_results=5,
                tags=["game"],
                include_actions=True,
            )

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/bin/prime", "--plain", "env", "list"])
        self.assertIn("--search", command)
        self.assertIn("wordle", command)
        self.assertIn("--tag", command)
        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["data"]["total"], 1)

    async def test_run_requires_positive_page(self) -> None:
        with self.assertRaisesRegex(ValueError, "page"):
            await prime_hub.run(page=0)


if __name__ == "__main__":
    unittest.main()
