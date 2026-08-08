import { spawnSync } from "node:child_process";

export function isGitHubNotFoundError(output) {
	return /^gh: [^\n]+ \(HTTP 404\)$/.test(output.trim());
}

export function isR2MissingObjectError(output) {
	return /^An error occurred \((?:NoSuchKey|404)\) when calling the GetObject operation:[^\n]*$/.test(output.trim());
}

export function isR2PreconditionFailure(output) {
	return /^An error occurred \((?:PreconditionFailed|412)\) when calling the PutObject operation:[^\n]*$/.test(
		output.trim(),
	);
}

export function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: { ...process.env, AWS_PAGER: "" },
		maxBuffer: 10 * 1024 * 1024,
		stdio: "pipe",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
		if (options.acceptFailure?.(output)) return undefined;
		if (options.allowFailure) return undefined;
		throw new Error(output || `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
	}
	return (result.stdout ?? "").trim();
}

export function readPublicGitHubBranchSha(repository, branch, runner = runCommand) {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new Error(`Invalid GitHub repository: ${repository}`);
	}
	if (!branch || /\s|\.\.|^[-/]|[/.]$/.test(branch)) {
		throw new Error(`Invalid GitHub branch: ${branch}`);
	}
	const ref = `refs/heads/${branch}`;
	const output = runner("git", [
		"ls-remote",
		"--exit-code",
		`https://github.com/${repository}.git`,
		ref,
	]);
	const [sha, resolvedRef, extra] = output.split("\t");
	if (extra !== undefined || !/^[0-9a-f]{40}$/.test(sha) || resolvedRef !== ref) {
		throw new Error(`Unable to resolve exact default-branch commit from: ${output}`);
	}
	return sha;
}
