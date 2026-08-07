import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type ExternalEditorTui = {
	terminal: { drainInput: (maxMs?: number, idleMs?: number) => Promise<void> };
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

export async function runExternalEditor(options: {
	tui: ExternalEditorTui;
	command: string;
	content: string;
	onTuiRestart?: () => void;
}): Promise<string | undefined> {
	const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.md`);
	let tuiStopped = false;

	try {
		fs.writeFileSync(tmpFile, options.content, "utf-8");
		await options.tui.terminal.drainInput(1000);
		options.tui.stop();
		tuiStopped = true;

		const [editor, ...editorArgs] = options.command.split(" ");
		const result = spawnSync(editor, [...editorArgs, tmpFile], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		if (result.error) {
			throw result.error;
		}
		return result.status === 0 ? fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "") : undefined;
	} finally {
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors
		}
		if (tuiStopped) {
			options.tui.start();
			options.onTuiRestart?.();
			options.tui.requestRender(true);
		}
	}
}
