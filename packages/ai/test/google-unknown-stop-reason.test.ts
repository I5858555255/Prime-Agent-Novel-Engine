import { describe, expect, it } from "vitest";
import { mapStopReason } from "../src/providers/google-shared.js";

describe("Google unknown finish reasons", () => {
	it("maps future finish reasons to structured failure instead of throwing", () => {
		const futureReason = "FUTURE_FINISH_REASON" as unknown as Parameters<typeof mapStopReason>[0];

		expect(mapStopReason(futureReason)).toBe("error");
	});
});
