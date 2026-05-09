from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

import prime_gpu


class PrimeGpuTests(unittest.IsolatedAsyncioTestCase):
    async def test_availability_builds_json_command(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout='{"gpu_resources":[],"total_count":0}',
            stderr="",
        )

        with (
            patch("prime_gpu.prime_gpu.shutil.which", return_value="/bin/prime"),
            patch("prime_gpu.prime_gpu.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_gpu.run(
                action="availability",
                gpu_type="H100_80GB",
                gpu_count=8,
                regions="united_states",
            )

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/bin/prime", "--plain", "availability", "list"])
        self.assertIn("--gpu-type", command)
        self.assertIn("--output", command)
        self.assertEqual(result["data"]["total_count"], 0)

    async def test_create_builds_pod_command(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["prime"],
            returncode=0,
            stdout="created",
            stderr="",
        )

        with (
            patch("prime_gpu.prime_gpu.shutil.which", return_value="/bin/prime"),
            patch("prime_gpu.prime_gpu.subprocess.run", return_value=completed) as run,
        ):
            result = await prime_gpu.run(
                action="create",
                gpu_type="A100_80GB",
                gpu_count=1,
                name="debug",
                env=["FOO=bar"],
                yes=True,
            )

        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["/bin/prime", "--plain", "pods", "create"])
        self.assertIn("--env", command)
        self.assertIn("--yes", command)
        self.assertIsNone(result["data"])

    async def test_status_requires_pod_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "pod_id"):
            await prime_gpu.run(action="status")


if __name__ == "__main__":
    unittest.main()
