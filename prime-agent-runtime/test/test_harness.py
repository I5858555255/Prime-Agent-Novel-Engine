from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from rlm import harness as package_harness
from rlm import rlm as callable_rlm
from rlm.harness import HarnessState, get_harness_state

PYTHON_REFERENCE = {
    "type": "python",
    "import": "agent_skills.example",
    "callable": "run",
    "call_pattern": "await run(...)",
}


class HarnessStateTest(unittest.TestCase):
    def test_crud_for_all_entry_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = {
                "prompt": state.create_prompt_note(
                    "Prompt note",
                    "Prompt content",
                    id="prompt_entry",
                    path="prompt/path",
                    metadata={"kind": "prompt"},
                ),
                "memory": state.create_memory(
                    "Memory",
                    "Memory content",
                    id="memory_entry",
                    path="memory/path",
                    metadata={"kind": "memory"},
                ),
                "skill": state.create_skill(
                    "Skill",
                    "Skill content",
                    id="skill_entry",
                    path="skill/path",
                    reference=PYTHON_REFERENCE,
                    arguments={"target": {"type": "string", "required": True}},
                    metadata={"kind": "skill"},
                ),
                "subagent": state.create_subagent(
                    "Subagent",
                    "Subagent content",
                    id="subagent_entry",
                    path="subagent/path",
                    metadata={"kind": "subagent"},
                ),
            }

            for kind, entry in created.items():
                self.assertEqual(entry.kind, kind)
                self.assertIn("content", state.get(kind, entry.id).content.lower())
                self.assertIn(entry, state.list(kind))

            state.update_prompt_note("prompt_entry", "Prompt note", "Prompt content updated")
            state.update_memory("memory_entry", "Memory", "Memory content updated")
            state.update_skill(
                "skill_entry",
                "Skill",
                "Skill content updated",
                reference=PYTHON_REFERENCE,
                arguments={"target": {"type": "string", "required": True}, "mode": {"type": "string"}},
            )
            state.update_subagent("subagent_entry", "Subagent", "Subagent content updated")

            for kind in ("prompt", "memory", "skill", "subagent"):
                entry_id = f"{kind}_entry"
                self.assertEqual(state.get(kind, entry_id).version, 2)
                self.assertIn("updated", state.get(kind, entry_id).content)
                delete_method = getattr(state, f"delete_{'prompt_note' if kind == 'prompt' else kind}")
                self.assertTrue(delete_method(entry_id))
                self.assertIsNone(state.get(kind, entry_id))
                self.assertFalse(delete_method(entry_id))

            self.assertEqual(state.list(), [])

    def test_persists_entries_and_refinements(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            memory = state.create_memory(
                "Prefer focused patches",
                "Small harness updates are easier to validate than broad rewrites.",
                path="engineering",
            )
            skill = state.create_skill(
                "Check failures first",
                "Inspect current failure evidence before editing code.",
                id="failure_first",
                reference=PYTHON_REFERENCE,
                arguments={"failure_log": {"type": "string", "description": "Current failure evidence."}},
            )
            subagent = state.create_subagent(
                "Reviewer",
                "Review the proposed patch for regressions and missing tests.",
                metadata={"max_turns": 3},
            )
            state.create_prompt_note("Refinement cadence", "Refine only after repeated evidence.")
            event = state.record_refinement(
                "skill failed twice",
                ["updated failure_first skill", "added reviewer subagent"],
                evidence="two failed validations",
                outcome="next validation passed",
            )

            reloaded = HarnessState(state.file_path)

            self.assertEqual(reloaded.get("memory", memory.id).content, memory.content)
            self.assertEqual(reloaded.get("skill", skill.id).version, 1)
            self.assertEqual(reloaded.get("skill", skill.id).arguments["failure_log"]["type"], "string")
            self.assertEqual(reloaded.get("subagent", subagent.id).metadata["max_turns"], 3)
            self.assertEqual(reloaded.refinements[0].id, event.id)
            self.assertIn("Prefer focused patches", reloaded.overview())
            self.assertIn(
                "Call contract: installed Python skills use await <skill_import>(...)",
                reloaded.overview(),
            )
            self.assertIn("await rlm('sub-task')", reloaded.overview())
            self.assertIn(
                "asyncio.gather(rlm('task1'), rlm('task2'))",
                reloaded.overview(),
            )
            self.assertIn("refinements: 1", reloaded.overview())

    def test_load_ignores_unknown_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "schema": 1,
                        "entries": {
                            "memory": {
                                "known": {
                                    "title": "Known memory",
                                    "content": "Loaded despite extra keys.",
                                    "version": "2",
                                    "unexpected": True,
                                },
                                "missing_content": {
                                    "title": "Missing content",
                                }
                            }
                        },
                        "refinements": [
                            {
                                "id": "refine_extra",
                                "trigger": "extra keys",
                                "changes": [1, "loaded"],
                                "ignored": "value",
                            },
                            {
                                "id": "refine_missing_changes",
                                "trigger": "missing changes",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            state = HarnessState(state_path)

            self.assertEqual(state.get("memory", "known").content, "Loaded despite extra keys.")
            self.assertEqual(state.get("memory", "known").version, 2)
            self.assertIsNone(state.get("memory", "missing_content"))
            self.assertEqual(state.refinements[0].id, "refine_extra")
            self.assertEqual(state.refinements[0].changes, ["1", "loaded"])
            self.assertEqual(len(state.refinements), 1)
            self.assertIn("1, loaded", state.overview())

            updated = state.update_memory("known", "Known memory", "Updated content.")
            self.assertEqual(updated.version, 3)

    def test_skill_arguments_are_first_class(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = state.create_skill(
                "Edit file",
                "Apply a targeted edit.",
                id="edit_file",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                },
            )
            updated = state.update_skill(
                "edit_file",
                "Edit file",
                "Apply a targeted edit after reading context.",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                    "validate": {"type": "boolean", "default": True},
                },
            )
            reloaded = HarnessState(state.file_path)

            self.assertEqual(created.arguments["path"]["required"], True)
            self.assertEqual(created.reference["type"], "python")
            self.assertEqual(updated.version, 2)
            self.assertEqual(reloaded.get("skill", "edit_file").arguments["validate"]["default"], True)
            self.assertEqual(reloaded.get("skill", "edit_file").reference["import"], "agent_skills.file_edit")
            self.assertIn('"path"', reloaded.overview())
            self.assertIn("agent_skills", reloaded.overview())

    def test_skill_references_must_be_python(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "Python reference"):
                state.create_skill("No reference", "missing", arguments={})
            with self.assertRaisesRegex(ValueError, "reference.type must be 'python'"):
                state.create_skill(
                    "Shell reference",
                    "bad",
                    reference={"type": "shell", "command": "edit"},
                    arguments={},
                )
            with self.assertRaisesRegex(ValueError, "Python import"):
                state.create_skill("No import", "bad", reference={"type": "python", "callable": "run"}, arguments={})
            with self.assertRaisesRegex(ValueError, "callable or call_pattern"):
                state.create_skill(
                    "No callable",
                    "bad",
                    reference={"type": "python", "import": "agent_skills.bad"},
                    arguments={},
                )

    def test_explicit_create_and_update_enforce_entry_existence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            first = state.create_skill("Triage", "old", id="triage", reference=PYTHON_REFERENCE, arguments={})
            with self.assertRaisesRegex(ValueError, "already exists"):
                state.create_skill("Triage", "duplicate", id="triage", reference=PYTHON_REFERENCE, arguments={})
            with self.assertRaisesRegex(ValueError, "does not exist"):
                state.update_skill("missing", "Missing", "missing", reference=PYTHON_REFERENCE, arguments={})

            second = state.update_skill("triage", "Triage", "new", reference=PYTHON_REFERENCE, arguments={})

            self.assertEqual(first.id, second.id)
            self.assertEqual(second.content, "new")
            self.assertEqual(second.version, 2)

    def test_explicit_state_dir_cache_uses_harness_state_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = get_harness_state(temp_dir)
            again = get_harness_state(temp_dir)

            self.assertIs(state, again)
            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_default_state_uses_global_harness_env_dir(self) -> None:
        previous = os.environ.get("RLM_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            try:
                state = HarnessState()
            finally:
                if previous is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous

            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_callable_rlm_exposes_harness_state_helpers(self) -> None:
        self.assertIs(callable_rlm.harness, package_harness)
        self.assertIs(callable_rlm.get_harness_state, get_harness_state)

    def test_record_refinement_accepts_single_change_string(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            event = state.record_refinement("manual cli test", "single change")

            self.assertEqual(event.changes, ["single change"])
            self.assertEqual(state.refinements[0].changes, ["single change"])

    def test_unknown_kind_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.upsert("tool", "Tool", "Tool content")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.get("tool", "tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.delete("tool", "tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.list("tool")


if __name__ == "__main__":
    unittest.main()
