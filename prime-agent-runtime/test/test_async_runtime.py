from __future__ import annotations

import asyncio
import unittest

from rlm.async_runtime import (
    ERROR,
    FINISHED,
    RUNNING,
    BackgroundWorker,
    FnProcessor,
    Registry,
)


async def settle(predicate, *, tries: int = 2000) -> None:
    """Yield to the loop until predicate() holds.

    Bounded so a wedged worker fails the test instead of hanging it.
    """
    for _ in range(tries):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("background worker never reached the expected state")


class Echo:
    """Stateless processor that returns each item and records what it saw."""

    def __init__(self) -> None:
        self.seen: list = []

    async def process(self, item):
        self.seen.append(item)
        return f"ans:{item}"

    async def teardown(self) -> None:
        return None


class BackgroundWorkerTest(unittest.IsolatedAsyncioTestCase):
    async def test_resident_worker_continues_under_one_name(self) -> None:
        registry = Registry()
        processor = Echo()
        factory = lambda name: BackgroundWorker(name, processor)  # noqa: E731

        first = registry.send("alpha", name="helper", worker_factory=factory)
        self.assertEqual(await first.wait(), "ans:alpha")

        # Re-sending the same name continues the SAME resident worker (multi-turn)
        # rather than building a fresh one.
        second = registry.send("beta", name="helper", worker_factory=factory)
        self.assertEqual(second.name, first.name)
        self.assertEqual(await second.wait(), "ans:beta")
        self.assertEqual(processor.seen, ["alpha", "beta"])

        await registry.close_all()

    async def test_poll_is_non_consuming_and_results_are_fifo(self) -> None:
        registry = Registry()
        factory = lambda name: BackgroundWorker(name, Echo())  # noqa: E731

        handle = registry.send(1, name="worker", worker_factory=factory)
        registry.send(2, name="worker", worker_factory=factory)
        registry.send(3, name="worker", worker_factory=factory)

        await settle(lambda: len(handle.poll().results) == 3)
        # poll() is a pure read: calling it repeatedly never drains a result.
        self.assertEqual(len(handle.poll().results), 3)
        self.assertEqual(len(handle.poll().results), 3)

        drained = [handle.poll().results.popleft() for _ in range(3)]
        self.assertEqual(drained, ["ans:1", "ans:2", "ans:3"])
        self.assertEqual(len(handle.poll().results), 0)

        await registry.close_all()

    async def test_status_moves_from_running_to_finished(self) -> None:
        registry = Registry()
        gate = asyncio.Event()

        class Gated:
            async def process(self, item):
                await gate.wait()
                return item

            async def teardown(self) -> None:
                return None

        handle = registry.send("x", name="worker", worker_factory=lambda n: BackgroundWorker(n, Gated()))

        # Blocked inside process(): the worker reports running until released.
        await settle(lambda: handle.poll().status == RUNNING)
        self.assertEqual(handle.poll().status, RUNNING)

        gate.set()
        self.assertEqual(await handle.wait(), "x")

        # Inbox drained -> the worker parks as finished (idle), not running.
        await settle(lambda: handle.poll().status == FINISHED)
        self.assertEqual(handle.poll().status, FINISHED)

        await registry.close_all()

    async def test_error_halts_worker_and_resend_rebuilds_it(self) -> None:
        registry = Registry()

        class Boom:
            async def process(self, item):
                raise RuntimeError(f"boom:{item}")

            async def teardown(self) -> None:
                return None

        class Ok:
            async def process(self, item):
                return f"ok:{item}"

            async def teardown(self) -> None:
                return None

        handle = registry.send("x", name="worker", worker_factory=lambda n: BackgroundWorker(n, Boom()))
        with self.assertRaisesRegex(RuntimeError, "boom:x"):
            await handle.wait()

        state = handle.poll()
        self.assertEqual(state.status, ERROR)
        self.assertIsInstance(state.error, RuntimeError)

        # Re-sending the name evicts the dead worker and rebuilds a fresh one,
        # so the name stays reusable.
        revived = registry.send("y", name="worker", worker_factory=lambda n: BackgroundWorker(n, Ok()))
        self.assertEqual(await revived.wait(), "ok:y")

        await registry.close_all()

    async def test_ephemeral_worker_runs_its_one_item_and_finishes(self) -> None:
        async def add_one(value):
            return value + 1

        worker = BackgroundWorker("once", FnProcessor(add_one), item=((41,), {}))
        self.assertEqual(await worker.wait(), 42)

        await settle(lambda: worker.status == FINISHED)
        self.assertEqual(worker.status, FINISHED)


if __name__ == "__main__":
    unittest.main()
