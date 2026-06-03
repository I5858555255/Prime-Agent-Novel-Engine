import { homedir } from "node:os";
import * as path from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	Container,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { formatNoModelsAvailableMessage } from "../src/core/auth-guidance.js";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.js";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import type {
	AgentConnectionModel,
	AgentConnectionResourceSnapshot,
	AgentConnectionSourceInfo,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";
import { formatSplashCwd, InteractiveMode, truncatePathMiddle } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function createConnectionState(overrides: Partial<AgentConnectionState> = {}): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/tmp/project",
		thinkingLevel: "medium",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session-1",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
		compactionCount: 0,
		goal: emptyGoalState(),
		scopedModels: [],
		activeToolNames: ["ipython"],
		contextUsage: undefined,
		...overrides,
	};
}

describe("InteractiveMode update notifications", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows the Prime Agent update command in one compact line", () => {
		const chatContainer = new Container();
		const fakeThis = {
			chatContainer,
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveMode;

		InteractiveMode.prototype.showNewVersionNotification.call(fakeThis, "1.2.3");

		const output = normalizeRenderedOutput(chatContainer);
		expect(chatContainer.children).toHaveLength(1);
		expect(output.split("\n")).toHaveLength(1);
		expect(output).toContain("Update available:");
		expect(output).toContain("v1.2.3");
		expect(output).toContain("prime-agent update");
		expect(output).not.toContain("pi update");
		expect(output).not.toContain("Changelog:");
	});

	test("shows package updates in one compact line", () => {
		const chatContainer = new Container();
		const fakeThis = {
			chatContainer,
			ui: { requestRender: vi.fn() },
		} as unknown as InteractiveMode;

		InteractiveMode.prototype.showPackageUpdateNotification.call(fakeThis, ["npm:@foo/bar"]);

		const output = normalizeRenderedOutput(chatContainer);
		expect(chatContainer.children).toHaveLength(1);
		expect(output.split("\n")).toHaveLength(1);
		expect(output).toContain("Package updates available:");
		expect(output).toContain("npm:@foo/bar");
		expect(output).toContain("prime-agent update --extensions");
		expect(output).not.toContain("pi update");
	});
});

type ExtensionFixture = {
	path: string;
	sourceInfo?: AgentConnectionSourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

type SubmitHandlerHarness = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { setText: (text: string) => void };
	showWarning: (message: string) => void;
	agentConnection: { prompt: (message: string) => Promise<void> };
};

describe("InteractiveMode submit handling", () => {
	test("rejects legacy bash shortcuts before reaching the agent connection", async () => {
		const fakeThis: SubmitHandlerHarness = {
			defaultEditor: {},
			editor: { setText: vi.fn() },
			showWarning: vi.fn(),
			agentConnection: { prompt: vi.fn(async () => {}) },
		};

		(
			InteractiveMode.prototype as unknown as {
				setupEditorSubmitHandler(this: SubmitHandlerHarness): void;
			}
		).setupEditorSubmitHandler.call(fakeThis);

		await fakeThis.defaultEditor.onSubmit?.("!pwd");

		expect(fakeThis.showWarning).toHaveBeenCalledWith(
			"Bash commands are not available in interactive mode. Use IPython for shell commands.",
		);
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
		expect(fakeThis.agentConnection.prompt).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode connection events", () => {
	test("clears extension UI when a connection-backed session is replaced", async () => {
		type SessionReplacedEvent = { type: "session_replaced"; state: AgentConnectionState; messages: [] };
		let listener: ((event: SessionReplacedEvent) => Promise<void> | void) | undefined;
		const fakeThis = {
			agentConnection: {
				subscribe: vi.fn((callback) => {
					listener = callback;
					return vi.fn();
				}),
			},
			resetExtensionUI: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			rebindCurrentSession: vi.fn(async () => {}),
			handleEvent: vi.fn(),
			handleConnectionExtensionUiRequest: vi.fn(),
			showError: vi.fn(),
		};

		(InteractiveMode.prototype as unknown as { subscribeToAgent(this: typeof fakeThis): void }).subscribeToAgent.call(
			fakeThis,
		);

		const state = createConnectionState();
		await listener?.({ type: "session_replaced", state, messages: [] });

		const resetOrder = fakeThis.resetExtensionUI.mock.invocationCallOrder[0];
		const applySnapshotOrder = fakeThis.applyConnectionStateSnapshot.mock.invocationCallOrder[0];
		expect(resetOrder).toBeLessThan(applySnapshotOrder);
		expect(fakeThis.applyConnectionStateSnapshot).toHaveBeenCalledWith(state);
		expect(fakeThis.rebindCurrentSession).toHaveBeenCalledWith();
	});
});

describe("InteractiveMode startup onboarding warnings", () => {
	type StartupWarningHarness = {
		shouldRunOnboarding(): boolean;
		getModelFallbackWarningAction(
			modelFallbackMessage: string | undefined,
			startupNeededOnboarding: boolean,
		): "show" | "suppress" | "wait";
	};

	const getModelFallbackWarningAction = (InteractiveMode.prototype as unknown as StartupWarningHarness)
		.getModelFallbackWarningAction;

	test("suppresses the stale no-model warning after onboarding selects a model", () => {
		const fakeThis: StartupWarningHarness = {
			shouldRunOnboarding: vi.fn(() => false),
			getModelFallbackWarningAction,
		};

		expect(getModelFallbackWarningAction.call(fakeThis, formatNoModelsAvailableMessage(), true)).toBe("suppress");
		expect(fakeThis.shouldRunOnboarding).toHaveBeenCalledTimes(1);
	});

	test("waits to suppress the stale no-model warning while onboarding is still needed", () => {
		const fakeThis: StartupWarningHarness = {
			shouldRunOnboarding: vi.fn(() => true),
			getModelFallbackWarningAction,
		};

		expect(getModelFallbackWarningAction.call(fakeThis, formatNoModelsAvailableMessage(), true)).toBe("wait");
		expect(fakeThis.shouldRunOnboarding).toHaveBeenCalledTimes(1);
	});

	test("keeps real model restore fallback warnings after onboarding", () => {
		const fakeThis: StartupWarningHarness = {
			shouldRunOnboarding: vi.fn(() => false),
			getModelFallbackWarningAction,
		};

		expect(
			getModelFallbackWarningAction.call(
				fakeThis,
				"Could not restore model anthropic/claude-old. Using prime-inference/openai/gpt-5.5.",
				true,
			),
		).toBe("show");
		expect(fakeThis.shouldRunOnboarding).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode model candidates", () => {
	type ModelCandidatesHarness = {
		agentConnection: { getAvailableModels: () => Promise<AgentConnectionModel[]> };
		connectionModels: AgentConnectionModel[];
		getScopedModelState(): AgentConnectionState["scopedModels"];
		getConnectionAvailableModels(): Promise<AgentConnectionModel[]>;
		getModelCandidates(): Promise<AgentConnectionModel[]>;
		getScopedModelsFromModelIds(
			enabledIds: readonly string[],
			allModels: readonly AgentConnectionModel[],
		): AgentConnectionState["scopedModels"];
	};
	const prototype = InteractiveMode.prototype as unknown as ModelCandidatesHarness;

	const createModel = (provider: string, id: string): AgentConnectionModel =>
		({
			provider,
			id,
			name: id,
		}) as AgentConnectionModel;

	test("loads unscoped model candidates through AgentConnection", async () => {
		const model = createModel("openai", "gpt-5.5");
		const getAvailableModels = vi.fn(async () => [model]);
		const fakeThis: ModelCandidatesHarness = {
			agentConnection: { getAvailableModels },
			connectionModels: [],
			getScopedModelState: () => [],
			getConnectionAvailableModels: prototype.getConnectionAvailableModels,
			getModelCandidates: prototype.getModelCandidates,
			getScopedModelsFromModelIds: prototype.getScopedModelsFromModelIds,
		};

		const result = await prototype.getModelCandidates.call(fakeThis);

		expect(result).toEqual([model]);
		expect(getAvailableModels).toHaveBeenCalledTimes(1);
		expect(fakeThis.connectionModels).toEqual([model]);
	});

	test("uses connection state for scoped model candidates", async () => {
		const model = createModel("anthropic", "claude-opus-4-5");
		const getAvailableModels = vi.fn(async () => [createModel("openai", "gpt-5.5")]);
		const fakeThis: ModelCandidatesHarness = {
			agentConnection: { getAvailableModels },
			connectionModels: [],
			getScopedModelState: () => [{ model, thinkingLevel: "medium" }],
			getConnectionAvailableModels: prototype.getConnectionAvailableModels,
			getModelCandidates: prototype.getModelCandidates,
			getScopedModelsFromModelIds: prototype.getScopedModelsFromModelIds,
		};

		const result = await prototype.getModelCandidates.call(fakeThis);

		expect(result).toEqual([model]);
		expect(getAvailableModels).not.toHaveBeenCalled();
	});

	test("maps selected scoped model IDs from connection candidates", () => {
		const anthropicModel = createModel("anthropic", "claude-opus-4-5");
		const openaiModel = createModel("openai", "gpt-5.5");

		const result = prototype.getScopedModelsFromModelIds(
			["missing/model", "anthropic/claude-opus-4-5", "anthropic/claude-opus-4-5", "openai/gpt-5.5"],
			[openaiModel, anthropicModel],
		);

		expect(result).toEqual([{ model: anthropicModel }, { model: openaiModel }]);
	});
});

describe("InteractiveMode model selection persistence", () => {
	type ModelSelectionHarness = {
		agentConnection: { setModel(provider: string, modelId: string): Promise<void> };
		uiServices: {
			settingsManager: { setDefaultModelAndProvider(provider: string, modelId: string): void };
		};
		footer: { invalidate(): void };
		patchConnectionState(patch: Partial<AgentConnectionState>): void;
		updateEditorBorderColor(): void;
		applySelectedModel(model: AgentConnectionModel): Promise<void>;
	};

	const createModel = (provider: string, id: string): AgentConnectionModel =>
		({
			provider,
			id,
			name: id,
		}) as AgentConnectionModel;

	test("persists local default only after the connection accepts the model", async () => {
		const order: string[] = [];
		const model = createModel("openai", "gpt-5.5");
		const fakeThis = Object.create(InteractiveMode.prototype) as ModelSelectionHarness;
		fakeThis.agentConnection = {
			setModel: vi.fn(async () => {
				order.push("connection");
			}),
		};
		fakeThis.uiServices = {
			settingsManager: {
				setDefaultModelAndProvider: vi.fn(() => {
					order.push("settings");
				}),
			},
		};
		fakeThis.footer = { invalidate: vi.fn() };
		fakeThis.patchConnectionState = vi.fn();
		fakeThis.updateEditorBorderColor = vi.fn();

		await fakeThis.applySelectedModel(model);

		expect(fakeThis.agentConnection.setModel).toHaveBeenCalledWith("openai", "gpt-5.5");
		expect(fakeThis.uiServices.settingsManager.setDefaultModelAndProvider).toHaveBeenCalledWith("openai", "gpt-5.5");
		expect(order).toEqual(["connection", "settings"]);
		expect(fakeThis.patchConnectionState).toHaveBeenCalledWith({ model });
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	test("does not persist local default when the connection rejects the model", async () => {
		const model = createModel("openai", "missing-model");
		const fakeThis = Object.create(InteractiveMode.prototype) as ModelSelectionHarness;
		fakeThis.agentConnection = {
			setModel: vi.fn(async () => {
				throw new Error("model unavailable");
			}),
		};
		fakeThis.uiServices = {
			settingsManager: {
				setDefaultModelAndProvider: vi.fn(),
			},
		};
		fakeThis.footer = { invalidate: vi.fn() };
		fakeThis.patchConnectionState = vi.fn();
		fakeThis.updateEditorBorderColor = vi.fn();

		await expect(fakeThis.applySelectedModel(model)).rejects.toThrow("model unavailable");

		expect(fakeThis.uiServices.settingsManager.setDefaultModelAndProvider).not.toHaveBeenCalled();
		expect(fakeThis.patchConnectionState).not.toHaveBeenCalled();
		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
		expect(fakeThis.updateEditorBorderColor).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode splash cwd display", () => {
	test("formats home-relative cwd paths", () => {
		expect(formatSplashCwd(homedir())).toBe("~");
		expect(formatSplashCwd(path.join(homedir(), "pi", "prime-agent"))).toBe("~/pi/prime-agent");
	});

	test("keeps worktree paths as cwd paths instead of repo branch labels", () => {
		expect(formatSplashCwd(path.join(homedir(), "pi", "prime-agent", ".worktrees", "improve-onboarding"))).toBe(
			"~/pi/prime-agent/.worktrees/improve-onboarding",
		);
	});
});

describe("InteractiveMode goal status announcements", () => {
	test("does not announce active goal usage-only updates", () => {
		type GoalAnnouncementHarness = {
			lastGoalAnnouncement?: unknown;
			setGoalAnnouncementBaseline(goal: GoalState): void;
			shouldAnnounceGoalUpdate(goal: GoalState): boolean;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as GoalAnnouncementHarness;
		const activeGoal: GoalState = {
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: "ship the feature",
			tokensUsed: 10,
			timeUsedSeconds: 5,
			continuationsUsed: 1,
		};

		fakeThis.setGoalAnnouncementBaseline(emptyGoalState());
		expect(fakeThis.shouldAnnounceGoalUpdate(activeGoal)).toBe(true);
		expect(
			fakeThis.shouldAnnounceGoalUpdate({
				...activeGoal,
				tokensUsed: 20,
				timeUsedSeconds: 15,
				continuationsUsed: 2,
			}),
		).toBe(false);
		expect(
			fakeThis.shouldAnnounceGoalUpdate({
				...activeGoal,
				objective: "ship the feature and update docs",
			}),
		).toBe(false);
	});

	test("announces a transition back to idle when a goal is cleared", () => {
		type GoalAnnouncementHarness = {
			setGoalAnnouncementBaseline(goal: GoalState): void;
			shouldAnnounceGoalUpdate(goal: GoalState): boolean;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as GoalAnnouncementHarness;
		fakeThis.setGoalAnnouncementBaseline({
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: "ship the feature",
			tokensUsed: 10,
			timeUsedSeconds: 5,
			continuationsUsed: 1,
		});

		expect(fakeThis.shouldAnnounceGoalUpdate(emptyGoalState())).toBe(true);
		expect(fakeThis.shouldAnnounceGoalUpdate(emptyGoalState())).toBe(false);
	});
});

describe("InteractiveMode tray goal label", () => {
	type TrayLabelHarness = {
		connectionState: {
			goal: GoalState;
			contextUsage: { contextWindow: number; percent: number | null } | undefined;
		};
		uiServices: { getContextUsage(): { contextWindow: number; percent: number | null } | undefined };
		getTrayContextLabel(): string | undefined;
	};
	const getTrayContextLabel = (InteractiveMode.prototype as unknown as TrayLabelHarness).getTrayContextLabel;

	test("shows active goals in the lower tray without an objective", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "a long objective that should not render in the tray",
				tokensUsed: 0,
				timeUsedSeconds: 65,
				continuationsUsed: 1,
			} satisfies GoalState,
			contextUsage: undefined,
		};
		fakeThis.uiServices = { getContextUsage: () => undefined };

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s)");
	});

	test("combines active goals with low-context signal in one lower-tray label", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "finish the task",
				tokensUsed: 0,
				timeUsedSeconds: 65,
				continuationsUsed: 1,
			} satisfies GoalState,
			contextUsage: { contextWindow: 100_000, percent: 75 },
		};
		fakeThis.uiServices = { getContextUsage: () => undefined };

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s) · 25% context left");
	});
});

describe("InteractiveMode.handleGoalStatusCommand", () => {
	test("prints current goal details without queuing through the agent", () => {
		type GoalStatusCommandHarness = {
			connectionState: { goal: GoalState };
			chatContainer: Container;
			ui: { requestRender(): void };
			handleGoalStatusCommand(): void;
			formatGoalElapsed(seconds: number): string;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as GoalStatusCommandHarness;
		fakeThis.connectionState = {
			goal: {
				active: true,
				status: "active",
				objective: "ship the feature",
				tokenBudget: 1000,
				tokensUsed: 125,
				timeUsedSeconds: 65,
				continuationsUsed: 2,
			},
		};
		fakeThis.chatContainer = new Container();
		fakeThis.ui = { requestRender: vi.fn() };

		fakeThis.handleGoalStatusCommand();

		const rendered = normalizeRenderedOutput(fakeThis.chatContainer);
		expect(rendered).toContain("Goal");
		expect(rendered).toContain("Status: active");
		expect(rendered).toContain("Objective: ship the feature");
		expect(rendered).toContain("Time: 1m 05s");
		expect(rendered).toContain("Tokens: 125 / 1,000");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("truncatePathMiddle", () => {
	test("does not duplicate the home prefix for short tilde paths", () => {
		const value = truncatePathMiddle("~/myproject", 8);

		expect(value).toMatch(/^~\//);
		expect(value).not.toContain("/~/");
		expect(visibleWidth(value)).toBeLessThanOrEqual(8);
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: AgentConnectionResourceSnapshot["diagnostics"]["skills"];
		useRealScopeGroups?: boolean;
	}) {
		const connectionResourceSnapshot: AgentConnectionResourceSnapshot = {
			contextFiles: (options.contextFiles ?? []).map((contextFile) => ({ path: contextFile.path })),
			skills: options.skills ?? [],
			prompts: [],
			extensions: options.extensions ?? [],
			themes: [],
			diagnostics: {
				skills: options.skillDiagnostics ?? [],
				prompts: [],
				extensions: [],
				themes: [],
			},
		};
		const extensionRunner = {
			getCommandDiagnostics: () => [],
			getShortcutDiagnostics: () => [],
		};
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			connectionResourceSnapshot,
			extensionRunner,
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getCurrentCwd: () => options.cwd ?? "/tmp/project",
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: AgentConnectionSourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): AgentConnectionSourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.pi/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("does not show resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("shows a compact resource listing when forced", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("commit");
		expect(output).not.toContain("resource-list");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, webfetch.ts"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  pi-markdown-preview"`);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.chatContainer)).toMatchInlineSnapshot(`
"[Extensions]
  project
    /tmp/project/.pi/extensions/answer.ts
    /tmp/project/.pi/extensions/local-index
    git:github.com/HazAT/pi-interactive-subagents
      extensions
      extensions/subagents
    npm:@scope/pi-scoped
      extensions
    npm:pi-markdown-preview
      extensions
  user
    /tmp/agent/extensions/user-index
  path
    /tmp/temp/cli-extension.ts"`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [{ path: path.join(home, ".pi", "agent", "AGENTS.md") }, { path: path.join(cwd, "AGENTS.md") }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.chatContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.pi/agent/AGENTS.md");
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		expect(output).not.toContain("~/.pi/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
