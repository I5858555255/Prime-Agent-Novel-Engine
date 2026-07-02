/**
 * Minimal structured logger shared by pi-ai and its consumers.
 *
 * The library itself never writes files: entries go to an injectable sink
 * (see setLogSink). Without a sink, warn/error fall back to console.error as
 * single JSON lines and debug/info are dropped, so standalone library use
 * stays quiet but never loses failures. Logging must never throw into the
 * caller.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	ts: string;
	level: LogLevel;
	component: string;
	msg: string;
	[field: string]: unknown;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
}

let sink: LogSink | undefined;

/** Install the process-wide log sink. Pass undefined to restore the default. */
export function setLogSink(next: LogSink | undefined): void {
	sink = next;
}

function emit(level: LogLevel, component: string, msg: string, fields?: Record<string, unknown>): void {
	try {
		const entry: LogEntry = { ts: new Date().toISOString(), level, component, msg, ...fields };
		if (sink) {
			sink(entry);
		} else if (level === "warn" || level === "error") {
			console.error(JSON.stringify(entry));
		}
	} catch {
		// Diagnostics must never break the operation being logged.
	}
}

export function getLogger(component: string): Logger {
	return {
		debug: (msg, fields) => emit("debug", component, msg, fields),
		info: (msg, fields) => emit("info", component, msg, fields),
		warn: (msg, fields) => emit("warn", component, msg, fields),
		error: (msg, fields) => emit("error", component, msg, fields),
	};
}
