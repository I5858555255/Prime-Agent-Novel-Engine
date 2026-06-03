import type { AgentSession, ExtensionBindings } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentSessionServices } from "../../core/agent-session-services.js";
import type { ExtensionCommandContext, ExtensionRunner, ToolDefinition } from "../../core/extensions/index.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { Theme } from "./theme/theme.js";

export interface InteractiveModeUiServices {
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	getInitialCwd(): string;
	getInitialSessionName(): string | undefined;
	getThemes(): Theme[];
}

type LocalExtensionNewSessionOptions = Parameters<ExtensionCommandContext["newSession"]>[0];
type LocalExtensionForkOptions = Parameters<ExtensionCommandContext["fork"]>[1];
type LocalExtensionSwitchOptions = NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]> & {
	cwdOverride?: string;
};
export type InteractiveModeLocalToolRendererDefinition = Pick<
	ToolDefinition,
	"renderCall" | "renderResult" | "renderShell"
>;

export interface InteractiveModeLocalSessionHost {
	createUiServices(): InteractiveModeUiServices;
	getSessionManager(): SessionManager;
	getExtensionRunner(): ExtensionRunner;
	getToolRendererDefinition(toolName: string): InteractiveModeLocalToolRendererDefinition | undefined;
	getSystemPrompt(): string;
	getAbortSignal(): AbortSignal | undefined;
	bindExtensions(bindings: ExtensionBindings): Promise<void>;
	newSession(options?: LocalExtensionNewSessionOptions): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: LocalExtensionForkOptions): Promise<{ cancelled: boolean; selectedText?: string }>;
	switchSession(sessionPath: string, options?: LocalExtensionSwitchOptions): Promise<{ cancelled: boolean }>;
}

export function createInteractiveModeUiServices(session: AgentSession): InteractiveModeUiServices {
	return {
		settingsManager: session.settingsManager,
		modelRegistry: session.modelRegistry,
		getInitialCwd: () => session.sessionManager.getCwd(),
		getInitialSessionName: () => session.sessionManager.getSessionName(),
		getThemes: () => session.resourceLoader.getThemes().themes,
	};
}

export function createInteractiveModeUiServicesFromServices(options: {
	services: AgentSessionServices;
	sessionManager: SessionManager;
}): InteractiveModeUiServices {
	const { services, sessionManager } = options;

	return {
		settingsManager: services.settingsManager,
		modelRegistry: services.modelRegistry,
		getInitialCwd: () => sessionManager.getCwd(),
		getInitialSessionName: () => sessionManager.getSessionName(),
		getThemes: () => services.resourceLoader.getThemes().themes,
	};
}

export function createInteractiveModeLocalSessionHost(
	runtimeHost: AgentSessionRuntime,
): InteractiveModeLocalSessionHost {
	return {
		createUiServices: () => createInteractiveModeUiServices(runtimeHost.session),
		getSessionManager: () => runtimeHost.session.sessionManager,
		getExtensionRunner: () => runtimeHost.session.extensionRunner,
		getToolRendererDefinition: (toolName) => {
			const definition = runtimeHost.session.getToolDefinition(toolName);
			if (!definition) {
				return undefined;
			}
			const rendererDefinition: InteractiveModeLocalToolRendererDefinition = {};
			if (definition.renderCall) {
				rendererDefinition.renderCall = definition.renderCall;
			}
			if (definition.renderResult) {
				rendererDefinition.renderResult = definition.renderResult;
			}
			if (definition.renderShell) {
				rendererDefinition.renderShell = definition.renderShell;
			}
			return Object.keys(rendererDefinition).length > 0 ? rendererDefinition : undefined;
		},
		getSystemPrompt: () => runtimeHost.session.systemPrompt,
		getAbortSignal: () => runtimeHost.session.agent.signal,
		bindExtensions: (bindings) => runtimeHost.session.bindExtensions(bindings),
		newSession: (options) => runtimeHost.newSession(options),
		fork: (entryId, options) => runtimeHost.fork(entryId, options),
		switchSession: (sessionPath, options) => runtimeHost.switchSession(sessionPath, options),
	};
}
