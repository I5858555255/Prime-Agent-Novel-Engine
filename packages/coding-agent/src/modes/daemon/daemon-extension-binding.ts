import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import type { ActiveSessionRecord } from "./active-session-record.js";
import type { DaemonOutbound } from "./daemon-protocol.js";

export interface ActiveSessionBindingCallbacks {
	broadcast: (record: ActiveSessionRecord, message: DaemonOutbound) => void;
	shutdown: () => void;
}

export async function bindActiveSessionRecord(
	record: ActiveSessionRecord,
	callbacks: ActiveSessionBindingCallbacks,
): Promise<void> {
	const session = record.runtime.session;

	record.unsubscribe?.();
	record.unsubscribe = session.subscribe((event) => {
		callbacks.broadcast(record, {
			type: "session_event",
			activeSessionId: record.activeSessionId,
			event,
		});
	});

	record.runtime.setRebindSession(async () => {
		await bindActiveSessionRecord(record, callbacks);
	});

	await session.bindExtensions({
		uiContext: createExtensionUIContext(record, callbacks.broadcast),
		commandContextActions: createCommandContextActions(record),
		shutdownHandler: callbacks.shutdown,
		onError: (error) => {
			callbacks.broadcast(record, {
				type: "extension_error",
				activeSessionId: record.activeSessionId,
				extensionPath: error.extensionPath,
				event: error.event,
				error: error.error,
			});
		},
	});
}

function createCommandContextActions(record: ActiveSessionRecord): ExtensionCommandContextActions {
	return {
		waitForIdle: () => record.runtime.session.agent.waitForIdle(),
		newSession: async (options) => record.runtime.newSession(options),
		fork: async (entryId, options) => {
			const result = await record.runtime.fork(entryId, options);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, options) => {
			const result = await record.runtime.session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},
		switchSession: async (sessionPath, options) => record.runtime.switchSession(sessionPath, options),
		reload: async () => {
			await record.runtime.session.reload();
		},
	};
}

function createExtensionUIContext(
	record: ActiveSessionRecord,
	broadcast: ActiveSessionBindingCallbacks["broadcast"],
): ExtensionUIContext {
	const emitUiRequest = (method: string, payload: Record<string, unknown>): void => {
		broadcast(record, {
			type: "extension_ui_request",
			activeSessionId: record.activeSessionId,
			method,
			payload,
		});
	};

	const dialogDefault = <T>(opts: ExtensionUIDialogOptions | undefined, fallback: T): Promise<T> => {
		if (opts?.signal?.aborted) {
			return Promise.resolve(fallback);
		}
		return new Promise((resolveDialog) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				opts?.signal?.removeEventListener("abort", onAbort);
			};
			const finish = () => {
				cleanup();
				resolveDialog(fallback);
			};
			const onAbort = () => finish();
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			timeoutId = setTimeout(finish, opts?.timeout ?? 0);
		});
	};

	return {
		select: (title, values, opts) => {
			emitUiRequest("select", { title, options: values, timeout: opts?.timeout });
			return dialogDefault(opts, undefined);
		},
		confirm: (title, message, opts) => {
			emitUiRequest("confirm", { title, message, timeout: opts?.timeout });
			return dialogDefault(opts, false);
		},
		input: (title, placeholder, opts) => {
			emitUiRequest("input", { title, placeholder, timeout: opts?.timeout });
			return dialogDefault(opts, undefined);
		},
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
			emitUiRequest("editor", { title, prefill });
			return Promise.resolve(undefined);
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
