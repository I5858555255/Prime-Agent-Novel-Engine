import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandTildePath } from "../src/config.js";

describe("expandTildePath", () => {
	it("returns the home directory for a bare tilde", () => {
		expect(expandTildePath("~")).toBe(homedir());
	});

	it("joins with the platform separator rather than concatenating", () => {
		// String concatenation produced "C:\Users\me/sessions" on Windows, which is
		// a working path but never compares equal to the same location built with
		// join() — so a configured session dir looked like a different directory.
		expect(expandTildePath("~/sessions")).toBe(join(homedir(), "sessions"));
	});

	it.runIf(process.platform === "win32")("produces a path with no forward slashes on Windows", () => {
		expect(expandTildePath("~/sessions")).not.toContain("/");
		expect(expandTildePath("~\\sessions")).toBe(join(homedir(), "sessions"));
	});

	it("expands nested paths", () => {
		expect(expandTildePath("~/a/b/c")).toBe(join(homedir(), "a", "b", "c"));
	});

	it("leaves paths without a leading tilde alone", () => {
		expect(expandTildePath("relative/path")).toBe("relative/path");
		expect(expandTildePath("~notahome")).toBe("~notahome");
	});
});
