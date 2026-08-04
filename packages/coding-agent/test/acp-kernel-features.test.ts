import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { KernelManager } from "../src/core/kernel/index.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { acpUpdatesForSessionEvent } from "../src/modes/acp/acp-events.js";
import { PRIME_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";

/**
 * Real-kernel verification for ACP mode.
 *
 * These tests boot an actual IPython kernel (no API key, no network) to prove
 * the capabilities ACP mode claims to preserve genuinely work, and that the
 * resulting output is representable over ACP. Mapper-level unit tests cannot
 * show that a kernel round trip still holds state or that harness CRUD runs.
 */

function bundledSkill(name: string, importName: string): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), name);
	return { name, importName, packagePath, pyprojectPath: join(packagePath, "pyproject.toml") };
}

/** Wrap kernel output the way the ipython tool result reaches the event stream. */
function toolEndEvent(toolCallId: string, output: string, isError = false): AgentConnectionSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "ipython",
		result: { output },
		isError,
	} as AgentConnectionSessionEvent;
}

describe("ACP mode over a real IPython kernel", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-acp-kernel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps IPython state across cells and represents each cell as an ACP execute call", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {});
		const manager: KernelManager = await provisioner.ensure();

		const first = await manager.execute("acp_state = 41\nprint('set')");
		expect(first.status).toBe("ok");
		// Persistence is the whole point of the kernel: a second cell must see it.
		const second = await manager.execute("print(acp_state + 1)");
		expect(second.status).toBe("ok");
		expect(second.stdout.trim()).toBe("42");

		const updates = acpUpdatesForSessionEvent(toolEndEvent("cell-2", second.stdout));
		expect(updates[0]).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "cell-2",
			status: "completed",
		});
		expect(JSON.stringify(updates[0]?.content)).toContain("42");
	}, 180_000);

	it("runs continual-harness CRUD in the kernel and can represent the result over ACP", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			env: { RLM_GLOBAL_HARNESS_STATE_DIR: join(tempDir, "harness") },
		});
		const manager = await provisioner.ensure();

		const result = await manager.execute(`
import json
entry = rlm.harness.create_memory(
    title="ACP verification memory",
    content="ACP mode preserves continual harness CRUD.",
    global_=True,
)
found = rlm.harness.get("memory", entry.id, global_=True)
listed = [item.id for item in rlm.harness.list("memory", global_=True)]
deleted = rlm.harness.delete("memory", entry.id, global_=True)
after = rlm.harness.get("memory", entry.id, global_=True)
print(json.dumps({
    "created": entry.id,
    "found": found.title if found else None,
    "listed": listed,
    "deleted": deleted,
    "after": after.title if after else None,
}, sort_keys=True))
`);
		expect(result.status, result.stderr).toBe("ok");
		const payload = JSON.parse(result.stdout.trim());
		expect(payload.found).toBe("ACP verification memory");
		expect(payload.listed).toContain(payload.created);
		expect(payload.deleted).toBe(true);
		expect(payload.after).toBeNull();

		// A refinement outcome for that CRUD is expressible as namespaced metadata.
		const refined = acpUpdatesForSessionEvent({
			type: "refine_complete",
			result: {
				summary: "persisted ACP verification memory",
				appliedEdits: [{ applied: true, action: "create", kind: "memory", id: payload.created }],
			},
		} as AgentConnectionSessionEvent);
		expect(refined[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: { refinement: { status: "complete" } },
		});
	}, 180_000);

	it("exposes rlm depth and subagent APIs to the kernel behind the ACP front end", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			env: { RLM_DEPTH: "0", RLM_MAX_DEPTH: "1" },
			hostHandlers: {
				"rlm.list_subagents": async () => ({
					subagents: [
						{
							rlm_child_id: "child-1",
							active_session_id: "active-1",
							session_id: "session-1",
							session_name: "reviewer",
							session_dir: tempDir,
							status: "completed",
						},
					],
				}),
				"rlm.delete_subagent": async (payload) => ({
					subagent: {
						rlm_child_id: String(payload.target),
						active_session_id: null,
						session_id: "session-1",
						session_name: "reviewer",
						session_dir: tempDir,
						status: "completed",
					},
				}),
			},
		});
		const manager = await provisioner.ensure();

		const result = await manager.execute(`
import json, os
children = await rlm.list_subagents()
removed = await rlm.delete_subagent(children[0])
print(json.dumps({
    "depth": os.environ.get("RLM_DEPTH"),
    "max_depth": os.environ.get("RLM_MAX_DEPTH"),
    "names": [child.session_name for child in children],
    "removed": removed.session_name,
}, sort_keys=True))
`);
		expect(result.status, result.stderr).toBe("ok");
		const payload = JSON.parse(result.stdout.trim());
		expect(payload.names).toEqual(["reviewer"]);
		expect(payload.removed).toBe("reviewer");
		expect(payload.depth).toBe("0");
		expect(payload.max_depth).toBe("1");
	}, 180_000);

	it("sends an agent-to-agent message from the kernel and surfaces it over ACP", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("agent-message", "agent_message")],
			hostHandlers: {
				// Host request type on main is "agent_message.list"; the roster rename
				// lives in an unmerged stack, so this branch targets main's API.
				"agent_message.list": async () => ({
					current: { activeSessionId: "alpha", sessionId: "session-alpha" },
					agents: [
						{
							activeSessionId: "beta",
							sessionId: "session-beta",
							sessionName: "reviewer",
							cwd: tempDir,
							isStreaming: false,
							unfinishedActionCount: 0,
						},
					],
				}),
				"agent_message.send": async (payload) => ({
					id: "agentmsg-acp",
					source: "agent_message",
					target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "reviewer" },
					message: payload.message,
					deliveryStatus: "queued",
					queuedAt: "2026-08-04T00:00:00.000Z",
					deliveryMode: payload.mode ?? "auto",
				}),
			},
		});
		const manager = await provisioner.ensure();

		const result = await manager.execute(`
import json
roster = await agent_message.list_agents()
receipt = await agent_message.send("beta", "status update")
print(json.dumps({
    "roster": [a.get("sessionName") for a in roster["agents"]],
    "status": receipt["deliveryStatus"],
}))
`);
		expect(result.status, result.stderr).toBe("ok");
		const payload = JSON.parse(result.stdout.trim());
		expect(payload.roster).toEqual(["reviewer"]);
		expect(payload.status).toBe("queued");

		// The kernel reports the send; ACP carries it as namespaced metadata.
		const sentMessages = result.sentAgentMessages ?? [];
		expect(sentMessages.length).toBeGreaterThan(0);
		const sent = sentMessages[0];
		const updates = acpUpdatesForSessionEvent({
			type: "ipython_sent_agent_message",
			toolCallId: "cell-msg",
			message: sent,
		} as AgentConnectionSessionEvent);
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: { agentMessage: { toolCallId: "cell-msg", deliveryStatus: "queued" } },
		});
	}, 180_000);
});
