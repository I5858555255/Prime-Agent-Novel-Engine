import { describe, expect, it } from "vitest";
import { parseStreamingJson, repairJson } from "../src/utils/json-parse.js";

const WINDOWS_PATH = ["C:", "users", "workspace", "project"].join("\\");
const MALFORMED_WINDOWS_PATH_JSON = `{"path":"${WINDOWS_PATH}"}`;

describe("repairJson", () => {
	it("repairs invalid unicode escape prefixes", () => {
		expect(repairJson(MALFORMED_WINDOWS_PATH_JSON)).toBe(JSON.stringify({ path: WINDOWS_PATH }));
	});

	it("preserves valid unicode escapes", () => {
		const json = `{"value":"\\u0041"}`;

		expect(repairJson(json)).toBe(json);
	});
});

describe("parseStreamingJson", () => {
	it("retains unescaped backslashes in Windows paths", () => {
		expect(parseStreamingJson(MALFORMED_WINDOWS_PATH_JSON)).toEqual({ path: WINDOWS_PATH });
	});
});
