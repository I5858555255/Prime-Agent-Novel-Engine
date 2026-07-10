import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type SideQuestionEvent, startSideQuestion } from "../../../src/core/side-question.js";
import { SideQuestionComponent } from "../../../src/modes/interactive/components/side-question.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText } from "../harness.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("ENG-4509 side questions", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("uses the current context without tools or session persistence", async () => {
		const harness = await createHarness({ systemPrompt: "Remember relevant project context." });
		try {
			harness.setResponses([fauxAssistantMessage("The codename is kestrel.")]);
			await harness.session.prompt("The project codename is kestrel.");
			harness.session.agent.sessionId = "cache-session";
			const systemPromptBefore = harness.session.agent.state.systemPrompt;
			const messagesBefore = structuredClone(harness.session.messages);
			const entriesBefore = structuredClone(harness.sessionManager.getEntries());
			const events: SideQuestionEvent[] = [];
			let observedTransport: string | undefined;
			let observedSessionId: string | undefined;

			harness.setResponses([
				(context, options) => {
					expect(context.systemPrompt).toBe(systemPromptBefore);
					expect(context.tools).toEqual([]);
					expect(context.messages.map(getMessageText)).toEqual([
						"The project codename is kestrel.",
						"The codename is kestrel.",
						expect.stringContaining("What is the project codename?"),
					]);
					observedTransport = options?.transport;
					observedSessionId = options?.sessionId;
					return fauxAssistantMessage("kestrel");
				},
			]);

			const run = startSideQuestion(
				harness.session.agent,
				"question-1",
				"What is the project codename?",
				(event) => {
					events.push(event);
				},
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "kestrel" });
			expect(observedTransport).toBe("sse");
			expect(observedSessionId).toBe("cache-session");
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		} finally {
			harness.cleanup();
		}
	});

	it("can finish while the main agent is still working", async () => {
		const harness = await createHarness();
		const mainStarted = deferred();
		const releaseMain = deferred();
		try {
			harness.setResponses([
				async () => {
					mainStarted.resolve();
					await releaseMain.promise;
					return fauxAssistantMessage("main complete");
				},
				(context) => {
					expect(context.tools).toEqual([]);
					expect(context.messages.map(getMessageText)).toEqual([
						"Run the main task.",
						expect.stringContaining("Can I ask this concurrently?"),
					]);
					return fauxAssistantMessage("yes");
				},
			]);

			const mainRun = harness.session.prompt("Run the main task.");
			await mainStarted.promise;
			const events: SideQuestionEvent[] = [];
			const sideRun = startSideQuestion(
				harness.session.agent,
				"question-2",
				"Can I ask this concurrently?",
				(event) => {
					events.push(event);
				},
			);
			await sideRun.done;

			expect(harness.session.isStreaming).toBe(true);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "yes" });
			releaseMain.resolve();
			await mainRun;
		} finally {
			releaseMain.resolve();
			await harness.session.agent.waitForIdle();
			harness.cleanup();
		}
	});

	it("cancels independently of the main agent", async () => {
		const harness = await createHarness();
		const sideStarted = deferred();
		try {
			harness.setResponses([
				async (_context, options) => {
					sideStarted.resolve();
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("");
				},
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(harness.session.agent, "question-3", "Wait here", (event) => {
				events.push(event);
			});
			await sideStarted.promise;
			run.abort();
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "cancelled" });
			expect(harness.session.isStreaming).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("renders a bounded one-turn panel above the prompt", () => {
		const component = new SideQuestionComponent(
			{
				id: "question-4",
				question: "What changed?",
				answer: "First line\n\nSecond line\n\nThird line\n\nFourth line",
				status: "complete",
			},
			() => 8,
		);
		const lines = component.render(40);
		const rendered = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(8);
		expect(lines.every((line) => line.includes("\x1b[48"))).toBe(true);
		expect(rendered).toContain("  /btw  What changed?");
		expect(rendered).not.toContain("  answer");
		expect(rendered).toContain("First line");
		expect(rendered).toContain("…");
	});

	it("closes and cancels a running pane before handling other Escape actions", () => {
		const abortSideQuestion = vi.fn(async () => true);
		const takeEscapeRepeatAction = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			sideQuestionEvent: {
				id: "question-5",
				question: "Still running?",
				answer: "",
				status: "running",
			},
			sideQuestionComponent: {},
			sideQuestionContainer: new Container(),
			agentConnection: { abortSideQuestion },
			isInitialized: false,
			clearCtrlCExitHint: vi.fn(),
			clearEscapeRepeat: vi.fn(),
			takeEscapeRepeatAction,
			armEscapeRepeat: vi.fn(),
			interruptOrClearInput: vi.fn(),
		});
		const handleEscape = (InteractiveMode.prototype as unknown as { handleEscape(this: typeof fakeThis): void })
			.handleEscape;

		handleEscape.call(fakeThis);

		expect(abortSideQuestion).toHaveBeenCalledWith("question-5");
		expect(fakeThis.sideQuestionEvent).toBeUndefined();
		expect(takeEscapeRepeatAction).not.toHaveBeenCalled();
	});
});
