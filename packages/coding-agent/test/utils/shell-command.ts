/**
 * Spell a native executable path so bash can run it.
 *
 * Autonomous gate commands go through bash on every platform, and a Windows
 * path breaks there twice over: bash reads its backslashes as escapes, and the
 * space in `C:\Program Files\...` splits it into two arguments.
 */
export function bashCommandPath(nativePath: string): string {
	return `"${nativePath.replaceAll("\\", "/")}"`;
}

/** The same, for a path embedded in JavaScript that bash-launched Node runs. */
export function bashLiteralPath(nativePath: string): string {
	return nativePath.replaceAll("\\", "/");
}
