import { randomUUID } from "node:crypto";
import type { AgentSession } from "../../core/agent-session.js";
import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import type { SubagentRuntimeHost } from "../../core/rlm-runtime.js";
import { createAgentConnectionState } from "../agent-connection/snapshot.js";
import type { AgentConnectionState } from "../agent-connection/types.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import type { ActiveSessionState } from "./active-session-state.js";
import { execEnvForSession, withClientEnv } from "./daemon-client-env.js";
import {
	type DaemonExtensionUIResponse,
	type DaemonOutbound,
	isDaemonDialogExtensionUiRequest,
} from "./daemon-protocol.js";

export interface ActiveSessionBindingCallbacks {
	broadcast: (state: ActiveSessionState, message: DaemonOutbound) => void;
	createConnectionState?: (state: ActiveSessionState) => AgentConnectionState;
	sessionReplaced?: (state: ActiveSessionState) => void;
	shutdown: () => void;
	subagentRuntimeHost?: SubagentRuntimeHost;
}

type BroadcastSessionEvent = Extract<DaemonOutbound, { type: "session_event" }>["event"];
type ExtensionUiRequest = Extract<DaemonOutbound, { type: "extension_ui_request" }>;

interface ExtensionUiBindingState {
	replacementsInProgress: number;
	staleSessions: WeakSet<AgentSession>;
}

interface DeferredExtensionUiRequests {
	messages: ExtensionUiRequest[];
}

/**
 * message_update events carry the full partial assistant message twice: once
 * as event.message and once nested as assistantMessageEvent.partial. Socket
 * clients read event.message (and assistantMessageEvent.type/toolCall), so the
 * nested copy is dropped before serialization, halving streaming wire bytes
 * per token. In-process consumers (extensions) still receive the full event.
 */
function slimSessionEventForWire(event: BroadcastSessionEvent): BroadcastSessionEvent {
	if (event.type !== "message_update") {
		return event;
	}
	const { partial: _partial, ...assistantMessageEvent } = event.assistantMessageEvent as { partial?: unknown };
	return {
		...event,
		assistantMessageEvent: assistantMessageEvent as typeof event.assistantMessageEvent,
	};
}

export async function bindActiveSessionState(
	state: ActiveSessionState,
	callbacks: ActiveSessionBindingCallbacks,
): Promise<void> {
	state.extensionStatuses ??= new Map();
	await bindSession(state, callbacks, { replacementsInProgress: 0, staleSessions: new WeakSet() }, false);
}

async function bindSession(
	state: ActiveSessionState,
	callbacks: ActiveSessionBindingCallbacks,
	uiState: ExtensionUiBindingState,
	deferPassiveExtensionUi: boolean,
): Promise<DeferredExtensionUiRequests> {
	const session = state.runtime.session;
	state.extensionStatuses ??= new Map();
	const statuses = state.extensionStatuses;
	const deferred: DeferredExtensionUiRequests = { messages: [] };
	let binding = true;
	const broadcastExtensionUi: ActiveSessionBindingCallbacks["broadcast"] = (targetState, message) => {
		if (message.type !== "extension_ui_request") {
			callbacks.broadcast(targetState, message);
			return;
		}
		const passive = !isDaemonDialogExtensionUiRequest(message.method);
		if (
			uiState.replacementsInProgress > 0 ||
			uiState.staleSessions.has(session) ||
			targetState.runtime.session !== session
		) {
			return;
		}
		if (passive) recordExtensionStatus(message, statuses);
		if (deferPassiveExtensionUi && binding && passive) {
			if (message.method !== "setStatus") deferred.messages.push(message);
			return;
		}
		callbacks.broadcast(targetState, message);
	};

	session.setExecEnvProvider(() => execEnvForSession(state.clientEnv));
	// Every runtime rebuild (new/switch/fork/import, subagent spawn) re-loads
	// extensions, which capture client env synchronously at that moment.
	state.runtime.setRuntimeEnvScope((fn) => withClientEnv(state.clientEnv, fn));

	state.unsubscribe?.();
	state.runtime.setSubagentRuntimeHost(callbacks.subagentRuntimeHost);
	state.runtime.setBeforeSessionReplace(() => {
		uiState.replacementsInProgress += 1;
		uiState.staleSessions.add(session);
	});
	state.runtime.setSessionReplaceFailed(() => {
		uiState.replacementsInProgress = Math.max(0, uiState.replacementsInProgress - 1);
	});
	state.unsubscribe = session.subscribe((event) => {
		callbacks.broadcast(state, {
			type: "session_event",
			activeSessionId: state.activeSessionId,
			event: slimSessionEventForWire(event),
		});
	});

	state.runtime.setRebindSession(async () => {
		uiState.replacementsInProgress = Math.max(0, uiState.replacementsInProgress - 1);
		const replacementUi = await bindSession(state, callbacks, uiState, true);
		callbacks.sessionReplaced?.(state);
		const connectionState =
			callbacks.createConnectionState?.(state) ?? createAgentConnectionState(state.runtime, state.activeSessionId);
		connectionState.extensionStatuses = Object.fromEntries(statuses);
		callbacks.broadcast(state, {
			type: "session_replaced",
			activeSessionId: state.activeSessionId,
			state: connectionState,
			messages: state.runtime.session.messages,
		});
		// The snapshot restores statuses atomically with the replacement render.
		// Deliver other passive UI updates only after that reset and snapshot.
		for (const message of replacementUi.messages) callbacks.broadcast(state, message);
	});

	await session.bindExtensions({
		uiContext: createExtensionUIContext(
			state,
			broadcastExtensionUi,
			() =>
				uiState.replacementsInProgress === 0 &&
				!uiState.staleSessions.has(session) &&
				state.runtime.session === session,
		),
		commandContextActions: createCommandContextActions(state),
		shutdownHandler: callbacks.shutdown,
		onError: (error) => {
			callbacks.broadcast(state, {
				type: "extension_error",
				activeSessionId: state.activeSessionId,
				extensionPath: error.extensionPath,
				event: error.event,
				error: error.error,
			});
		},
	});
	binding = false;

	return deferred;
}

function recordExtensionStatus(message: ExtensionUiRequest, statuses: Map<string, string>): void {
	if (message.method !== "setStatus") return;
	const statusKey = message.payload.statusKey;
	if (typeof statusKey !== "string") return;
	const statusText = message.payload.statusText;
	if (typeof statusText === "string") statuses.set(statusKey, statusText);
	else statuses.delete(statusKey);
}

function createCommandContextActions(state: ActiveSessionState): ExtensionCommandContextActions {
	return {
		waitForIdle: () => state.runtime.session.waitForIdle(),
		newSession: async (options) => state.runtime.newSession(options),
		fork: async (entryId, options) => {
			const result = await state.runtime.fork(entryId, options);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, options) => {
			const result = await state.runtime.session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},
		switchSession: async (sessionPath, options) => state.runtime.switchSession(sessionPath, options),
		reload: async () => {
			// Reload re-evaluates extension modules, which capture client env
			// (e.g. herdr pane identity) synchronously at load.
			await withClientEnv(state.clientEnv, () => state.runtime.session.reload());
		},
	};
}

function createExtensionUIContext(
	state: ActiveSessionState,
	broadcast: ActiveSessionBindingCallbacks["broadcast"],
	isActive: () => boolean,
): ExtensionUIContext {
	const emitUiRequest = (method: string, payload: Record<string, unknown>): string | undefined => {
		if (!isActive()) return undefined;
		const id = randomUUID();
		broadcast(state, {
			type: "extension_ui_request",
			activeSessionId: state.activeSessionId,
			id,
			method,
			payload,
		});
		return id;
	};

	const dialogRequest = <T>(
		method: string,
		payload: Record<string, unknown>,
		opts: ExtensionUIDialogOptions | undefined,
		fallback: T,
		resolveResponse: (response: DaemonExtensionUIResponse) => T,
	): Promise<T> => {
		if (!isActive()) return Promise.resolve(fallback);
		if (opts?.signal?.aborted) {
			return Promise.resolve(fallback);
		}
		if (!hasExtensionUiClientForMethod(state, method)) {
			return Promise.resolve(fallback);
		}
		const requestId = emitUiRequest(method, payload);
		if (!requestId) return Promise.resolve(fallback);
		return new Promise((resolveDialog) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				opts?.signal?.removeEventListener("abort", onAbort);
				state.extensionUiRequests.delete(requestId);
			};
			const finish = (value: T) => {
				cleanup();
				resolveDialog(value);
			};
			const onAbort = () => finish(fallback);
			state.extensionUiRequests.set(requestId, {
				resolve: (response) => finish(resolveResponse(response)),
			});
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => finish(fallback), opts.timeout);
			}
		});
	};

	return {
		select: (title, values, opts) =>
			dialogRequest("select", { title, options: values, timeout: opts?.timeout }, opts, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),
		confirm: (title, message, opts) =>
			dialogRequest("confirm", { title, message, timeout: opts?.timeout }, opts, false, (response) =>
				"confirmed" in response ? response.confirmed : false,
			),
		input: (title, placeholder, opts) =>
			dialogRequest("input", { title, placeholder, timeout: opts?.timeout }, opts, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),
		notify: (message, notifyType) => emitUiRequest("notify", { message, notifyType }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => emitUiRequest("setStatus", { statusKey: key, statusText: text }),
		setWorkingMessage: (message) => emitUiRequest("setWorkingMessage", { message }),
		setWorkingVisible: (visible) => emitUiRequest("setWorkingVisible", { visible }),
		setWorkingIndicator: (indicatorOptions?: WorkingIndicatorOptions) =>
			emitUiRequest("setWorkingIndicator", { options: indicatorOptions }),
		setHiddenThinkingLabel: (label) => emitUiRequest("setHiddenThinkingLabel", { label }),
		setWidget: (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => {
			if (content === undefined || Array.isArray(content)) {
				emitUiRequest("setWidget", {
					widgetKey: key,
					widgetLines: content,
					widgetPlacement: widgetOptions?.placement,
				});
			}
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (title) => emitUiRequest("setTitle", { title }),
		async custom<T>(): Promise<T> {
			return undefined as T;
		},
		pasteToEditor: (text) => emitUiRequest("setEditorText", { text }),
		setEditorText: (text) => emitUiRequest("setEditorText", { text }),
		getEditorText: () => "",
		editor: (title, prefill) => {
			return dialogRequest("editor", { title, prefill }, undefined, undefined, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			);
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): Theme {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not supported in daemon mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function hasExtensionUiClientForMethod(state: ActiveSessionState, method: string): boolean {
	if (!isDaemonDialogExtensionUiRequest(method)) {
		return state.clients.size > 0;
	}
	return [...state.clients].some((client) => client.supportsExtensionUi);
}
