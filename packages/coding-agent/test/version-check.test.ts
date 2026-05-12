import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPrimeAgentVersion,
	comparePackageVersions,
	getLatestPrimeAgentRelease,
	getLatestPrimeAgentVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const originalSkipVersionCheck = process.env.PRIME_AGENT_SKIP_VERSION_CHECK;
const originalOffline = process.env.PRIME_AGENT_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PRIME_AGENT_SKIP_VERSION_CHECK;
	} else {
		process.env.PRIME_AGENT_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.PRIME_AGENT_OFFLINE;
	} else {
		process.env.PRIME_AGENT_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPrimeAgentVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPrimeAgentVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the Prime Agent version check API with a Prime Agent user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPrimeAgentVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/PrimeIntellect-ai/prime-agent/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^prime-agent\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package name from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ packageName: "@new-scope/prime-agent", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPrimeAgentRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/prime-agent",
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PRIME_AGENT_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPrimeAgentVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
