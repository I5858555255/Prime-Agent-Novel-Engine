import { afterEach, describe, expect, test, vi } from "vitest";
import { getLogger, type LogEntry, setLogSink } from "../src/log.js";

afterEach(() => {
	setLogSink(undefined);
	vi.restoreAllMocks();
});

describe("structured logger", () => {
	test("routes entries with component, level, and fields to the sink", () => {
		const entries: LogEntry[] = [];
		setLogSink((entry) => entries.push(entry));

		const log = getLogger("test.component");
		log.info("hello", { a: 1 });
		log.error("boom", { requestId: "req_123" });

		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ level: "info", component: "test.component", msg: "hello", a: 1 });
		expect(entries[1]).toMatchObject({ level: "error", msg: "boom", requestId: "req_123" });
		expect(new Date(entries[0].ts).getTime()).not.toBeNaN();
	});

	test("without a sink, warn/error fall back to console.error and debug/info are dropped", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = getLogger("test");
		log.debug("quiet");
		log.info("quiet");
		log.warn("loud");
		log.error("loud");
		expect(consoleError).toHaveBeenCalledTimes(2);
	});

	test("a throwing sink never propagates into the caller", () => {
		setLogSink(() => {
			throw new Error("sink is broken");
		});
		expect(() => getLogger("test").error("boom")).not.toThrow();
	});
});
