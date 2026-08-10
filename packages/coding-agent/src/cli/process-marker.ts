/**
 * Mark the current process so child processes can identify both the Pi-compatible
 * coding-agent environment and Prime Agent specifically.
 */
export function markCodingAgentProcess(env: NodeJS.ProcessEnv = process.env): void {
	env.PI_CODING_AGENT = "true";
	env.PRIME_AGENT = "true";
}
