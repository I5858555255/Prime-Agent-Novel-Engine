import { describe, expect, it } from "vitest";
import { quoteScriptMagicArgument } from "../src/core/tools/ipython.js";

describe("quoteScriptMagicArgument", () => {
	it("leaves shell-safe values unquoted on every platform", () => {
		expect(quoteScriptMagicArgument("/bin/bash", "linux")).toBe("/bin/bash");
		expect(quoteScriptMagicArgument("/bin/bash", "win32")).toBe("/bin/bash");
	});

	it("single-quotes for the POSIX shlex mode IPython uses off Windows", () => {
		expect(quoteScriptMagicArgument("/opt/my shell/bash", "linux")).toBe("'/opt/my shell/bash'");
		expect(quoteScriptMagicArgument("/opt/it's/bash", "darwin")).toBe(`'/opt/it'"'"'s/bash'`);
	});

	it("double-quotes on Windows, where shlex runs with posix=False and keeps single quotes", () => {
		// A single-quoted path would reach the magic as `'C:\...'` and fail with
		// "Couldn't find program".
		expect(quoteScriptMagicArgument("C:\\Program Files\\Git\\bin\\bash.exe", "win32")).toBe(
			'"C:\\Program Files\\Git\\bin\\bash.exe"',
		);
	});
});
