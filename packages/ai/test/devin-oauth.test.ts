import { describe, expect, it } from "vitest";
import { getOAuthProvider } from "../src/utils/oauth/index.js";

describe("Devin OAuth", () => {
	it("registers Devin as a built-in OAuth provider", () => {
		expect(getOAuthProvider("devin")).toMatchObject({
			id: "devin",
			name: "Devin",
		});
	});
});
