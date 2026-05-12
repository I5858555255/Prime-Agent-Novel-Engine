import { describe, expect, it } from "vitest";
import { getPrimeAgentUserAgent } from "../src/utils/prime-agent-user-agent.js";

describe("getPrimeAgentUserAgent", () => {
	it("formats the Prime Agent user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPrimeAgentUserAgent("1.2.3");

		expect(userAgent).toBe(`prime-agent/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^prime-agent\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
