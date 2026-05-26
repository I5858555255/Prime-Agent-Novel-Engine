import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const mocks = vi.hoisted(() => ({
	exec: vi.fn(),
}));

vi.mock("child_process", () => ({
	exec: mocks.exec,
}));

function createFakeTui(): TUI {
	return {
		requestRender: vi.fn(),
	} as unknown as TUI;
}

describe("LoginDialogComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		mocks.exec.mockClear();
	});

	it("renders browser login without legacy border chrome", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");

		dialog.showAuth("https://example.com/oauth?client_id=test", "Complete login in your browser.");
		const output = stripAnsi(dialog.render(88).join("\n"));

		expect(output).toContain("Login to Anthropic");
		expect(output).toContain("Browser sign-in");
		expect(output).toContain("Sign-in link");
		expect(output).toContain("https://example.com/oauth?client_id=test");
		expect(output).toContain("Next step");
		expect(output).toContain("Complete login in your browser.");
		expect(output).not.toContain("─");
		expect(output).not.toContain("> ");
		expect(mocks.exec).toHaveBeenCalledOnce();
	});

	it("renders verification codes as a distinct field", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");

		dialog.showAuth("https://example.com/challenge", "Code: abc-123");
		const output = stripAnsi(dialog.render(88).join("\n"));

		expect(output).toContain("Verification code");
		expect(output).toContain("abc-123");
		expect(output).not.toContain("Code: abc-123");
	});

	it("renders API key prompts without shell input markers", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "openai", () => {}, "OpenAI");

		void dialog.showPrompt("Enter API key:");
		const output = stripAnsi(dialog.render(88).join("\n"));

		expect(output).toContain("Login to OpenAI");
		expect(output).toContain("Enter API key:");
		expect(output).not.toContain("─");
		expect(output).not.toContain("> ");
	});
});
