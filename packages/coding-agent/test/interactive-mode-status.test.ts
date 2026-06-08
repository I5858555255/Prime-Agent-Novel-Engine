import { homedir } from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type AutocompleteProvider, Container, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { formatNoModelsAvailableMessage } from "../src/core/auth-guidance.js";
import type { AuthStatus } from "../src/core/auth-storage.js";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
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
		expect(output).toContain("prime-agent update --packages");
		expect(output).not.toContain("pi update");
	});
});

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

describe("InteractiveMode Prime CLI onboarding", () => {
	type OnboardingHarness = {
		shouldRunOnboarding(): boolean;
		completeOnboarding(): void;
		handleModelCommand(searchTerm?: string): Promise<void>;
		runOnboardingFlow(): Promise<boolean>;
	};
	type OnboardingFake = OnboardingHarness & {
		runtimeHost: {
			session: {
				model?: Model<"openai-completions">;
				setModel?: (model: Model<"openai-completions">) => Promise<void>;
				modelRegistry: {
					refresh: () => void;
					getAvailable: () => Model<"openai-completions">[];
					hasConfiguredAuth: (model: unknown) => boolean;
					getProviderAuthStatus: (provider: string) => AuthStatus;
				};
				settingsManager: {
					getOnboardingCompleted: () => boolean;
					setOnboardingCompleted: (completed: boolean) => void;
				};
			};
		};
		footer?: { invalidate: () => void };
		updateEditorBorderColor?: () => void;
		showStatus?: (message: string) => void;
		showError?: (message: string) => void;
		maybeWarnAboutAnthropicSubscriptionAuth?: (model?: Model<"openai-completions">) => void;
		checkDaxnutsEasterEgg?: (model: { provider: string; id: string }) => void;
		findExactModelMatch?: (searchTerm: string) => Promise<Model<"openai-completions"> | undefined>;
		showOnboardingModelSelectionSplash?: () => Promise<boolean>;
		promptForModelSelection?: (options?: { allowProviderSetup?: boolean }) => Promise<boolean>;
	};
	const shouldRunOnboarding = (InteractiveMode.prototype as unknown as OnboardingHarness).shouldRunOnboarding;
	const completeOnboarding = (InteractiveMode.prototype as unknown as OnboardingHarness).completeOnboarding;
	const handleModelCommand = (InteractiveMode.prototype as unknown as OnboardingHarness).handleModelCommand;
	const runOnboardingFlow = (InteractiveMode.prototype as unknown as OnboardingHarness).runOnboardingFlow;

	const primeModel: Model<"openai-completions"> = {
		id: "openai/gpt-5.5",
		name: "GPT-5.5",
		api: "openai-completions",
		provider: PRIME_INFERENCE_PROVIDER_ID,
		baseUrl: "https://api.pinference.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	};

	function createPrimeCliHarness(completed: boolean): OnboardingFake {
		const fakeThis = Object.create(InteractiveMode.prototype) as OnboardingFake;
		fakeThis.runtimeHost = {
			session: {
				model: primeModel,
				modelRegistry: {
					refresh: vi.fn(),
					getAvailable: vi.fn(() => [primeModel]),
					hasConfiguredAuth: vi.fn(() => true),
					getProviderAuthStatus: vi.fn(
						(): AuthStatus => ({
							configured: false,
							source: "prime_cli",
						}),
					),
				},
				settingsManager: {
					getOnboardingCompleted: vi.fn(() => completed),
					setOnboardingCompleted: vi.fn(),
				},
			},
		};
		return fakeThis;
	}

	test("shows onboarding when the selected Prime model is backed by Prime CLI auth", () => {
		const fakeThis = createPrimeCliHarness(false);

		expect(shouldRunOnboarding.call(fakeThis)).toBe(true);
		expect(fakeThis.runtimeHost.session.modelRegistry.refresh).toHaveBeenCalledTimes(1);
	});

	test("skips Prime CLI onboarding after it has been completed", () => {
		const fakeThis = createPrimeCliHarness(true);

		expect(shouldRunOnboarding.call(fakeThis)).toBe(false);
	});

	test("persists onboarding completion once", () => {
		const fakeThis = createPrimeCliHarness(false);

		completeOnboarding.call(fakeThis);

		expect(fakeThis.runtimeHost.session.settingsManager.setOnboardingCompleted).toHaveBeenCalledWith(true);
	});

	test("manual exact model selection completes Prime CLI onboarding", async () => {
		let completed = false;
		const fakeThis = createPrimeCliHarness(false);
		fakeThis.runtimeHost.session.model = undefined;
		fakeThis.runtimeHost.session.settingsManager.getOnboardingCompleted = vi.fn(() => completed);
		fakeThis.runtimeHost.session.settingsManager.setOnboardingCompleted = vi.fn((nextCompleted: boolean) => {
			completed = nextCompleted;
		});
		fakeThis.runtimeHost.session.setModel = vi.fn(async (model: Model<"openai-completions">) => {
			fakeThis.runtimeHost.session.model = model;
		});
		fakeThis.findExactModelMatch = vi.fn(async () => primeModel);
		fakeThis.footer = { invalidate: vi.fn() };
		fakeThis.updateEditorBorderColor = vi.fn();
		fakeThis.showStatus = vi.fn();
		fakeThis.showError = vi.fn();
		fakeThis.maybeWarnAboutAnthropicSubscriptionAuth = vi.fn();
		fakeThis.checkDaxnutsEasterEgg = vi.fn();

		await handleModelCommand.call(fakeThis, "prime-inference/openai/gpt-5.5");

		expect(fakeThis.runtimeHost.session.setModel).toHaveBeenCalledWith(primeModel);
		expect(fakeThis.runtimeHost.session.settingsManager.setOnboardingCompleted).toHaveBeenCalledWith(true);
		expect(shouldRunOnboarding.call(fakeThis)).toBe(false);
	});

	test("cancelled model picker does not complete Prime CLI onboarding", async () => {
		const fakeThis = createPrimeCliHarness(false);
		fakeThis.showOnboardingModelSelectionSplash = vi.fn(async () => true);
		fakeThis.promptForModelSelection = vi.fn(async () => false);
		fakeThis.showStatus = vi.fn();

		await expect(runOnboardingFlow.call(fakeThis)).resolves.toBe(false);

		expect(fakeThis.promptForModelSelection).toHaveBeenCalledWith({ allowProviderSetup: true });
		expect(fakeThis.runtimeHost.session.settingsManager.setOnboardingCompleted).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Model selection required. Use /model to continue.");
	});

	test("cancelled model picker continues when current model is ready outside Prime CLI onboarding", async () => {
		const fakeThis = createPrimeCliHarness(false);
		fakeThis.runtimeHost.session.modelRegistry.getProviderAuthStatus = vi.fn(
			(): AuthStatus => ({
				configured: true,
				source: "stored",
			}),
		);
		fakeThis.promptForModelSelection = vi.fn(async () => false);
		fakeThis.showStatus = vi.fn();

		await expect(runOnboardingFlow.call(fakeThis)).resolves.toBe(true);

		expect(fakeThis.promptForModelSelection).toHaveBeenCalledWith({ allowProviderSetup: true });
		expect(fakeThis.runtimeHost.session.settingsManager.setOnboardingCompleted).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
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
		runtimeHost: {
			session: {
				goalState: GoalState;
				getContextUsage(): { contextWindow: number; percent: number | null } | undefined;
			};
		};
		getTrayContextLabel(): string | undefined;
	};
	const getTrayContextLabel = (InteractiveMode.prototype as unknown as TrayLabelHarness).getTrayContextLabel;

	test("shows active goals in the lower tray without an objective", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.runtimeHost = {
			session: {
				goalState: {
					active: true,
					status: "active",
					objective: "a long objective that should not render in the tray",
					tokensUsed: 0,
					timeUsedSeconds: 65,
					continuationsUsed: 1,
				} satisfies GoalState,
				getContextUsage: () => undefined,
			},
		};

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s)");
	});

	test("combines active goals with low-context signal in one lower-tray label", () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as TrayLabelHarness;
		fakeThis.runtimeHost = {
			session: {
				goalState: {
					active: true,
					status: "active",
					objective: "finish the task",
					tokensUsed: 0,
					timeUsedSeconds: 65,
					continuationsUsed: 1,
				} satisfies GoalState,
				getContextUsage: () => ({ contextWindow: 100_000, percent: 75 }),
			},
		};

		expect(getTrayContextLabel.call(fakeThis)).toBe("Pursuing goal (1m 05s) · 25% context left");
	});
});

describe("InteractiveMode.handleGoalStatusCommand", () => {
	test("prints current goal details without queuing through the agent", () => {
		type GoalStatusCommandHarness = {
			runtimeHost: {
				session: {
					goalState: GoalState;
				};
			};
			chatContainer: Container;
			ui: { requestRender(): void };
			handleGoalStatusCommand(): void;
			formatGoalElapsed(seconds: number): string;
		};
		const fakeThis = Object.create(InteractiveMode.prototype) as GoalStatusCommandHarness;
		fakeThis.runtimeHost = {
			session: {
				goalState: {
					active: true,
					status: "active",
					objective: "ship the feature",
					tokenBudget: 1000,
					tokensUsed: 125,
					timeUsedSeconds: 65,
					continuationsUsed: 2,
				},
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
	test("applies expansion state to the active header, chat entries, and child agent detail", () => {
		const header = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const childAgentDetail = { setToolsExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			chatContainer: { children: [chatChild] },
			childAgentDetail,
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(childAgentDetail.setToolsExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("sets a fresh base provider on active editors", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const provider: AutocompleteProvider = {
			async getSuggestions() {
				return null;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
			shouldTriggerFileCompletion() {
				return true;
			},
		};

		const fakeThis = {
			createBaseAutocompleteProvider: vi.fn(() => provider),
			defaultEditor,
			editor: customEditor,
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(fakeThis.createBaseAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledWith(provider);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledWith(provider);
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
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
	}) {
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
			session: {
				promptTemplates: [],
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		return fakeThis;
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
