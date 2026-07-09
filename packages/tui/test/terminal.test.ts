import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});

describe("ProcessTerminal alternate screen handoff", () => {
	it("inherits a preserved alternate screen into the next terminal instance", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, true);
			second.stop();
			assert.equal(second.altScreenActive, false);

			const third = new ProcessTerminal();
			assert.equal(third.altScreenActive, false);
			assert.ok(writes.includes("\x1b[?1049h"));
			assert.ok(writes.includes("\x1b[?1049l"));
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});
});
