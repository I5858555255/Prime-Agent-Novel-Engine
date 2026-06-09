import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { computeEditDiff } from "../src/core/tools/edit-diff.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (stripAnsi(lastRender).includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the diff in the call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
		await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

		const old_str = "line 50\nline 51\nline 52";
		const new_str = "line 50\nline 51 changed\nline 52";
		const diff = await computeEditDiff(filePath, old_str, new_str, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const root = new Container();
		for (let i = 0; i < 200; i++) {
			root.addChild(new Text(`history ${i}`, 0, 0));
		}

		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-1",
			{ path: filePath, old_str, new_str },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rawCallRender = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"line 51 changed",
			() => tui.requestRender(true),
		);
		const callOnlyRender = stripAnsi(rawCallRender);
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).toContain("line 51 changed");

		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		component.updateResult(
			{
				content: [{ type: "text", text: `Edited ${filePath}` }],
				details: diff,
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();

		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);

		const settledRender = stripAnsi(component.render(80).join("\n"));
		expect(settledRender).toContain("line 51 changed");
		expect(settledRender).not.toContain("Edited");
	});

	it("reconstructs the boxed preview from a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

		const old_str = "line 50\nline 51\nline 52";
		const new_str = "line 50\nline 51 changed\nline 52";
		const diff = await computeEditDiff(filePath, old_str, new_str, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}
		await rm(filePath, { force: true });

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-replay",
			{ path: filePath, old_str, new_str },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.updateResult(
			{
				content: [{ type: "text", text: `Edited ${filePath}` }],
				details: diff,
				isError: false,
			},
			false,
		);
		await waitForRender();
		await waitForRender();

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("line 51 changed");
	});

	it("shows a preflight error without rendering a diff when the edit does not apply", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-preflight-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		await writeFile(filePath, "line 0\nline 1\n", "utf8");

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-2",
			{ path: filePath, old_str: "does not exist", new_str: "replacement" },
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"Could not find",
			() => tui.requestRender(true),
		);
		expect(rendered).not.toContain("+1 ");
		expect(rendered).not.toContain("-1 ");
	});
});
