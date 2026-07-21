const SESSION_COMMAND_HANDLED_PREFIX = "[session-command-handled] ";

export class SessionCommandHandledError extends Error {
	readonly code = "session_command_handled" as const;

	constructor(message: string, options?: ErrorOptions) {
		super(`${SESSION_COMMAND_HANDLED_PREFIX}${message}`, options);
	}
}

export function deserializeSessionCommandError(message: string): SessionCommandHandledError | undefined {
	return message.startsWith(SESSION_COMMAND_HANDLED_PREFIX)
		? new SessionCommandHandledError(message.slice(SESSION_COMMAND_HANDLED_PREFIX.length))
		: undefined;
}
