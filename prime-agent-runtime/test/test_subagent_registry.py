from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmSubagentRegistryTest(unittest.TestCase):
    def test_lists_parent_scoped_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": "active-child",
                        "session_id": "session-child",
                        "session_name": "subagent-check-api-a1b2c3d4",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "completed",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(len(subagents), 1)
        self.assertEqual(subagents[0].rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(subagents[0].active_session_id, "active-child")
        self.assertEqual(subagents[0].session_id, "session-child")
        self.assertEqual(subagents[0].session_name, "subagent-check-api-a1b2c3d4")
        self.assertEqual(subagents[0].session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        self.assertEqual(subagents[0].status, "completed")
        host_request.assert_awaited_once_with("rlm.list_subagents")


    def test_lists_failed_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-failed",
                        "active_session_id": None,
                        "session_id": None,
                        "session_name": "failed-worker",
                        "session_dir": "/tmp/parent/sub-failed",
                        "status": "error",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(subagents[0].status, "error")

    def test_forwards_orchestrator_chosen_name_and_model_to_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-a1b2c3d4",
                "name": "api-reviewer",
                "session_dir": "/tmp/parent/sub-a1b2c3d4",
                "model": "deepseek/deepseek-v4-flash",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(
                rlm_module.rlm(
                    "check the API",
                    name="api-reviewer",
                    model="deepseek/deepseek-v4-flash",
                    resources=["port:4100", "database:test"],
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.run",
            {
                "prompt": "check the API",
                "kwargs": {
                    "name": "api-reviewer",
                    "model": "deepseek/deepseek-v4-flash",
                    "resources": ["port:4100", "database:test"],
                },
            },
        )
        self.assertEqual(result.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(result.name, "api-reviewer")
        self.assertEqual(result.model, "deepseek/deepseek-v4-flash")

    def test_finds_authenticated_models_through_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "models": [
                    {
                        "provider": "anthropic",
                        "id": "claude-opus-4-7",
                        "name": "Claude Opus 4.7",
                        "selector": "anthropic/claude-opus-4-7",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            models = asyncio.run(rlm_module.rlm.find_models("opus", limit=3))

        self.assertEqual(models[0].provider, "anthropic")
        self.assertEqual(models[0].id, "claude-opus-4-7")
        self.assertEqual(models[0].name, "Claude Opus 4.7")
        self.assertEqual(models[0].selector, "anthropic/claude-opus-4-7")
        host_request.assert_awaited_once_with(
            "rlm.find_models",
            {"query": "opus", "limit": 3},
        )

    def test_rejects_invalid_model_search_input_and_response(self) -> None:
        with self.assertRaisesRegex(TypeError, "query must be str"):
            asyncio.run(rlm_module.find_models(123))
        with self.assertRaisesRegex(TypeError, "limit must be int"):
            asyncio.run(rlm_module.find_models("opus", limit="3"))

        host_request = AsyncMock(return_value={"models": [{"provider": "anthropic"}]})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid model entry"):
                asyncio.run(rlm_module.find_models("opus"))

    def test_deletes_subagent_by_name_through_host(self) -> None:
        deleted_payload = {
            "rlm_child_id": "sub-a1b2c3d4",
            "active_session_id": "active-child",
            "session_id": "session-child",
            "session_name": "api-reviewer",
            "session_dir": "/tmp/parent/sub-a1b2c3d4",
            "status": "completed",
        }
        host_request = AsyncMock(return_value={"subagent": deleted_payload})

        with patch.object(rlm_module, "host_request", host_request):
            deleted = asyncio.run(rlm_module.rlm.delete_subagent("  api-reviewer  "))

        self.assertEqual(deleted.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(deleted.session_name, "api-reviewer")
        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "api-reviewer"},
        )

    def test_deletes_subagent_object_by_child_id(self) -> None:
        subagent = rlm_module.RLMSubagent(
            rlm_child_id="sub-a1b2c3d4",
            active_session_id=None,
            session_id="session-child",
            session_name="api-reviewer",
            session_dir=Path("/tmp/parent/sub-a1b2c3d4"),
            status="running",
        )
        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": subagent.rlm_child_id,
                    "active_session_id": subagent.active_session_id,
                    "session_id": subagent.session_id,
                    "session_name": subagent.session_name,
                    "session_dir": str(subagent.session_dir),
                    "status": subagent.status,
                }
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.delete_subagent(subagent))

        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "sub-a1b2c3d4"},
        )

    def test_cancels_running_subagent_explicitly(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": "sub-a1b2c3d4",
                    "active_session_id": "active-child",
                    "session_id": "session-child",
                    "session_name": "api-reviewer",
                    "session_dir": "/tmp/parent/sub-a1b2c3d4",
                    "status": "running",
                },
                "outcome": "cancelled",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            cancelled = asyncio.run(rlm_module.rlm.cancel_subagent(" api-reviewer "))

        self.assertEqual(cancelled.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(cancelled.session_name, "api-reviewer")
        self.assertEqual(cancelled.outcome, "cancelled")
        host_request.assert_awaited_once_with(
            "rlm.cancel_subagent",
            {"target": "api-reviewer"},
        )

    def test_returns_scheduler_summary_from_host(self) -> None:
        summary = {
            "workspaceId": "/tmp/repo",
            "runId": "run-1056",
            "updatedAt": "2026-08-09T00:00:00.000Z",
            "taskCounts": {"running": 1},
            "agentCounts": {"running": 1},
            "readyTaskIds": [],
            "blockedTaskIds": [],
            "activeAgents": [],
        }
        host_request = AsyncMock(return_value=summary)

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.scheduler_summary())

        self.assertEqual(result, summary)
        host_request.assert_awaited_once_with("rlm.scheduler_summary")

    def test_retries_retained_integration_through_host(self) -> None:
        subagent = {
            "rlm_child_id": "sub-retry",
            "active_session_id": None,
            "session_id": "session-retry",
            "session_name": "retry-worker",
            "session_dir": "/tmp/parent/sub-retry",
            "status": "completed",
        }
        host_request = AsyncMock(
            return_value={
                "subagent": subagent,
                "outcome": "promoted",
                "integration": {
                    "taskId": "sub-retry",
                    "status": "integrated",
                    "promotionStatus": "promoted",
                },
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.retry_integration(" retry-worker "))

        self.assertEqual(result.outcome, "promoted")
        self.assertEqual(result.subagent.rlm_child_id, "sub-retry")
        self.assertEqual(result.integration["promotionStatus"], "promoted")
        host_request.assert_awaited_once_with(
            "rlm.retry_integration",
            {"target": "retry-worker"},
        )

    def test_abandons_retained_integration_with_reason(self) -> None:
        subagent = {
            "rlm_child_id": "sub-abandon",
            "active_session_id": None,
            "session_id": "session-abandon",
            "session_name": "abandon-worker",
            "session_dir": "/tmp/parent/sub-abandon",
            "status": "error",
        }
        host_request = AsyncMock(
            return_value={
                "subagent": subagent,
                "outcome": "abandoned",
                "integration": {
                    "taskId": "sub-abandon",
                    "status": "failed",
                    "promotionStatus": "failed",
                },
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(
                rlm_module.rlm.abandon_integration(
                    "abandon-worker",
                    reason=" Parent chose another fix ",
                )
            )

        self.assertEqual(result.outcome, "abandoned")
        host_request.assert_awaited_once_with(
            "rlm.abandon_integration",
            {"target": "abandon-worker", "reason": "Parent chose another fix"},
        )

    def test_rejects_invalid_integration_control_input_and_response(self) -> None:
        with self.assertRaisesRegex(ValueError, "target must not be empty"):
            asyncio.run(rlm_module.retry_integration("  "))
        with self.assertRaisesRegex(TypeError, "reason must be str or None"):
            asyncio.run(rlm_module.abandon_integration("child", reason=123))
        with self.assertRaisesRegex(ValueError, "reason must not be empty"):
            asyncio.run(rlm_module.abandon_integration("child", reason="  "))
        with self.assertRaisesRegex(ValueError, "reason must be at most 1024 characters"):
            asyncio.run(rlm_module.abandon_integration("child", reason="x" * 1025))

        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": "sub-invalid",
                    "active_session_id": None,
                    "session_id": None,
                    "session_name": "invalid-worker",
                    "session_dir": "/tmp/parent/sub-invalid",
                    "status": "error",
                },
                "outcome": "unexpected",
                "integration": {"taskId": "sub-invalid"},
            }
        )
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid outcome"):
                asyncio.run(rlm_module.retry_integration("invalid-worker"))

    def test_rejects_invalid_delete_response_and_target(self) -> None:
        host_request = AsyncMock(return_value={"subagent": {"status": "completed"}})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "rlm.delete_subagent entry is missing rlm_child_id"):
                asyncio.run(rlm_module.delete_subagent("api-reviewer"))

        with self.assertRaisesRegex(ValueError, "target must not be empty"):
            asyncio.run(rlm_module.delete_subagent("   "))
        with self.assertRaisesRegex(TypeError, "target must be str or RLMSubagent"):
            asyncio.run(rlm_module.delete_subagent(123))

    def test_rejects_invalid_registry_payload(self) -> None:
        host_request = AsyncMock(return_value={"subagents": [{"status": "completed"}]})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing rlm_child_id"):
                asyncio.run(rlm_module.list_subagents())

    def test_requires_a_default_session_name(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": None,
                        "session_id": "session-child",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "running",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing session_name"):
                asyncio.run(rlm_module.list_subagents())


if __name__ == "__main__":
    unittest.main()
