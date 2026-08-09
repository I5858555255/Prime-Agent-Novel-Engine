import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecuteOptions, ExecuteResult } from "../src/core/kernel/index.js";
import { createIpythonToolDefinition, type IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("IPython oversized output materialization", () => {
	it("keeps the model-facing result bounded while retaining full stdout and result behind one handle", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-ipython-output-"));
		roots.push(root);
		const fullStdout = `stdout-head\n${"private output payload\n".repeat(900)}stdout-tail`;
		const fullResult = `result-head\n${"private result payload\n".repeat(900)}result-tail`;
		const execute = async (_code: string, executeOptions: ExecuteOptions): Promise<ExecuteResult> => {
			executeOptions.onStream?.(fullStdout, "stdout");
			executeOptions.onResult?.(fullResult);
			return {
				stdout: fullStdout.slice(0, 65_536),
				stderr: "",
				result: fullResult.slice(0, 65_536),
				status: "ok",
				durationMs: 1,
			};
		};
		const fakeProvisioner = {
			ensure: async () => ({ execute }),
			registerHostHandlers: () => {},
		} as unknown as IpythonKernelProvisioner;
		const tool = createIpythonToolDefinition(process.cwd(), {
			provisioner: fakeProvisioner,
			snapshotDir: root,
			outputMaterialization: { inlineChars: 512, previewChars: 300 },
		});

		const response = await tool.execute(
			"call-1",
			{ code: "print('large')" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (response.content[0] as { type: "text"; text: string }).text;
		const details = response.details;

		expect(details.artifacts).toHaveLength(1);
		expect(text).toContain("stdout-head");
		expect(text).toContain("stdout-tail");
		expect(text).toContain("artifact.read");
		expect(text).not.toContain(fullStdout);
		expect(text).not.toContain(fullResult);
		expect(details.stdout).not.toContain(fullStdout);
		expect(details.result).not.toContain(fullResult);
		expect(JSON.stringify(response)).not.toContain(fullStdout);
		expect(JSON.stringify(response)).not.toContain(fullResult);
	});

	it("bounds a huge exception value even when no traceback was emitted", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-ipython-error-"));
		roots.push(root);
		const fullEvalue = `private exception payload\n${"private error detail\n".repeat(900)}`;
		const execute = async (): Promise<ExecuteResult> => ({
			stdout: "",
			stderr: "",
			result: "",
			status: "error",
			durationMs: 1,
			error: { ename: "ValueError", evalue: fullEvalue, traceback: [] },
		});
		const fakeProvisioner = {
			ensure: async () => ({ execute }),
			registerHostHandlers: () => {},
		} as unknown as IpythonKernelProvisioner;
		const tool = createIpythonToolDefinition(process.cwd(), {
			provisioner: fakeProvisioner,
			snapshotDir: root,
			outputMaterialization: { previewChars: 300 },
		});

		const response = await tool.execute(
			"call-2",
			{ code: "raise ValueError('large')" },
			undefined,
			undefined,
			undefined as never,
		);

		const encoded = JSON.stringify(response);
		expect(response.details.error?.evalue).not.toBe(fullEvalue);
		expect(response.details.error?.evalue).toContain("output omitted");
		expect(encoded).not.toContain(fullEvalue);
	});

	it("disposes spilled captures when execution is rejected", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-ipython-output-rejected-"));
		roots.push(root);
		const fullStdout = "private rejected output\n".repeat(200);
		const execute = async (_code: string, executeOptions: ExecuteOptions): Promise<ExecuteResult> => {
			executeOptions.onStream?.(fullStdout, "stdout");
			throw new Error("execution rejected");
		};
		const fakeProvisioner = {
			ensure: async () => ({ execute }),
			registerHostHandlers: () => {},
		} as unknown as IpythonKernelProvisioner;
		const tool = createIpythonToolDefinition(process.cwd(), {
			provisioner: fakeProvisioner,
			snapshotDir: root,
			outputMaterialization: { inlineChars: 32, previewChars: 32 },
		});

		await expect(
			tool.execute("call-rejected", { code: "print('large')" }, undefined, undefined, undefined as never),
		).rejects.toThrow("execution rejected");
		expect(readdirSync(join(root, "ipython-output", ".tmp"))).toHaveLength(0);
	});
});
