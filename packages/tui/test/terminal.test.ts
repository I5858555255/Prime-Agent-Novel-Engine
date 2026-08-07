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
	it("keeps raw input active and discards keys until the next fullscreen TUI starts", () => {
		const io = mockProcessTerminalIo();
		const firstInputs: string[] = [];
		const secondInputs: string[] = [];
		try {
			const first = io.createTerminal();
			first.start(
				(data) => firstInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?1u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			assert.equal(io.isRaw(), true);
			process.stdin.emit("data", "\x1b[B");
			assert.deepEqual(firstInputs, []);

			const second = io.createTerminal();
			second.start(
				(data) => secondInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?1u");
			process.stdin.emit("data", "x");

			assert.equal(io.isRaw(), true);
			assert.deepEqual(secondInputs, ["x"]);
			second.stop();
			assert.equal(io.isRaw(), false);
			assert.deepEqual(io.rawModeChanges, [true, true, false]);
		} finally {
			io.restore();
		}
	});

	it("does not inherit an active alternate screen before it is preserved", () => {
		const io = mockProcessTerminalIo();
		try {
			const first = io.createTerminal();
			first.enterAltScreen();

			const second = io.createTerminal();
			assert.equal(second.altScreenActive, false);
			second.stop();

			assert.equal(io.writes.filter((write) => write === "\x1b[?1049l").length, 0);
			first.leaveAltScreen();
			assert.equal(io.writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			io.restore();
		}
	});

	it("inherits a preserved alternate screen into the next terminal instance", () => {
		const io = mockProcessTerminalIo();
		try {
			const first = io.createTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = io.createTerminal();
			assert.equal(second.altScreenActive, true);
			second.stop();
			assert.equal(second.altScreenActive, false);

			const third = io.createTerminal();
			assert.equal(third.altScreenActive, false);
			assert.ok(io.writes.includes("\x1b[?1049h"));
			assert.ok(io.writes.includes("\x1b[?1049l"));
		} finally {
			io.restore();
		}
	});

	it("lets the preserving terminal cancel a handoff before it is consumed", () => {
		const io = mockProcessTerminalIo();
		try {
			const first = io.createTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });
			assert.equal(first.altScreenActive, false);

			first.leaveAltScreen();
			assert.equal(io.writes.filter((write) => write === "\x1b[?1049l").length, 1);

			const second = io.createTerminal();
			assert.equal(second.altScreenActive, false);
		} finally {
			io.restore();
		}
	});

	it("only hands a preserved alternate screen to one terminal instance", () => {
		const io = mockProcessTerminalIo();
		try {
			const first = io.createTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = io.createTerminal();
			const third = io.createTerminal();
			assert.equal(second.altScreenActive, true);
			assert.equal(third.altScreenActive, false);

			second.stop();
			assert.equal(io.writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			io.restore();
		}
	});

	it("migrates Kitty mode when negotiation finishes before fullscreen", () =>
		runWithMockTerminal(async (terminal, io) => {
			process.stdin.emit("data", "\x1b[?0u");
			terminal.enterAltScreen();

			await terminal.drainInput(0);
			terminal.leaveAltScreen();

			assert.deepEqual(io.keyboardScreenWrites(), [
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049l",
			]);
		}));

	it("pops Kitty mode before leaving fullscreen when negotiation finishes there", () =>
		runWithMockTerminal(async (terminal, io) => {
			terminal.enterAltScreen();
			process.stdin.emit("data", "\x1b[?0u");

			await terminal.drainInput(0);
			terminal.leaveAltScreen();

			assert.deepEqual(io.keyboardScreenWrites(), ["\x1b[?1049h", "\x1b[>7u", "\x1b[<u", "\x1b[?1049l"]);
		}));

	it("suppresses a Kitty response that arrives while input is draining", () =>
		runWithMockTerminal(async (terminal, io) => {
			terminal.enterAltScreen();

			const pendingDrain = terminal.drainInput(25, 5);
			process.stdin.emit("data", "\x1b[?0u");
			await pendingDrain;
			assert.equal(terminal.kittyProtocolActive, false);
			terminal.leaveAltScreen();

			assert.deepEqual(io.keyboardScreenWrites(), ["\x1b[?1049h", "\x1b[?1049l"]);
		}));

	it("cancels the modifyOtherKeys fallback while input is draining", () =>
		runWithMockTerminal(async (terminal, io) => {
			await terminal.drainInput(200, 175);

			assert.equal(io.writes.includes("\x1b[>4;2m"), false);
		}));
});

function restoreProperty(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(object, key, descriptor);
	} else {
		Reflect.deleteProperty(object, key);
	}
}

async function runWithMockTerminal(
	run: (terminal: ProcessTerminal, io: ReturnType<typeof mockProcessTerminalIo>) => Promise<void>,
): Promise<void> {
	const io = mockProcessTerminalIo();
	const terminal = io.createTerminal();
	try {
		terminal.start(
			() => {},
			() => {},
		);
		await run(terminal, io);
	} finally {
		io.restore();
	}
}

function mockProcessTerminalIo() {
	const originalWrite = process.stdout.write;
	const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
	const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	const originalResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
	const originalPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
	const terminals: ProcessTerminal[] = [];
	const rawModeChanges: boolean[] = [];
	const writes: string[] = [];
	let isRaw = false;

	Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => isRaw });
	Object.defineProperty(process.stdin, "setRawMode", {
		configurable: true,
		value: (enabled: boolean) => {
			isRaw = enabled;
			rawModeChanges.push(enabled);
			return process.stdin;
		},
	});
	Object.defineProperty(process.stdin, "resume", { configurable: true, value: () => process.stdin });
	Object.defineProperty(process.stdin, "pause", { configurable: true, value: () => process.stdin });
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
		const chunk = args[0];
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (!text.startsWith("\x1b")) {
			return Reflect.apply(originalWrite, process.stdout, args) as boolean;
		}
		writes.push(text);
		const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
		callback?.();
		return true;
	}) as typeof process.stdout.write;

	return {
		createTerminal: () => {
			const terminal = new ProcessTerminal();
			terminals.push(terminal);
			return terminal;
		},
		isRaw: () => isRaw,
		rawModeChanges,
		writes,
		keyboardScreenWrites: () =>
			writes.filter((write) => ["\x1b[?1049h", "\x1b[>7u", "\x1b[<u", "\x1b[?1049l"].includes(write)),
		restore: () => {
			for (const terminal of terminals.reverse()) {
				terminal.stop();
			}
			process.stdout.write = originalWrite;
			restoreProperty(process.stdin, "isRaw", originalIsRaw);
			restoreProperty(process.stdin, "setRawMode", originalSetRawMode);
			restoreProperty(process.stdin, "resume", originalResume);
			restoreProperty(process.stdin, "pause", originalPause);
		},
	};
}
