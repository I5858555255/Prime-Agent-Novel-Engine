export interface PythonExecuteOptions {
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Cap stdout / stderr / result at this many characters. */
	maxOutputChars?: number;
}

export interface PythonExecuteResult {
	stdout: string;
	stderr: string;
	/** Last expression result, if the cell produced one. */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

export interface PythonExecutionBackend {
	start(): Promise<void>;
	execute(code: string, options?: PythonExecuteOptions): Promise<PythonExecuteResult>;
	restart(): Promise<void>;
	dispose(): Promise<void>;
	readonly isRunning: boolean;
}
