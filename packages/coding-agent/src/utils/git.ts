import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import hostedGitInfo from "hosted-git-info";

/**
 * Parsed git URL information.
 */
export type GitSource = {
	/** Always "git" for git sources */
	type: "git";
	/** Clone URL (always valid for git clone, without ref suffix) */
	repo: string;
	/** Git host domain (e.g., "github.com") */
	host: string;
	/** Repository path (e.g., "user/repo") */
	path: string;
	/** Git ref (branch, tag, commit) if specified */
	ref?: string;
	/** True if ref was specified (package won't be auto-updated) */
	pinned: boolean;
};

function splitRef(url: string): { repo: string; ref?: string } {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) {
		return { repo: url };
	}
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}
	return {
		repo: `${host}/${repoPath}`,
		ref,
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (
		repoWithoutRef.startsWith("https://") ||
		repoWithoutRef.startsWith("http://") ||
		repoWithoutRef.startsWith("ssh://") ||
		repoWithoutRef.startsWith("git://")
	) {
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}
		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}
		repo = `https://${repoWithoutRef}`;
	}

	const normalizedPath = path.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !normalizedPath || normalizedPath.split("/").length < 2) {
		return null;
	}

	return {
		type: "git",
		repo,
		host,
		path: normalizedPath,
		ref,
		pinned: Boolean(ref),
	};
}

/**
 * Parse git source into a GitSource.
 *
 * Rules:
 * - With git: prefix, accept all historical shorthand forms.
 * - Without git: prefix, only accept explicit protocol URLs.
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = trimmed.startsWith("git:");
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	const split = splitRef(url);

	const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of hostedCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			const useHttpsPrefix =
				!split.repo.startsWith("http://") &&
				!split.repo.startsWith("https://") &&
				!split.repo.startsWith("ssh://") &&
				!split.repo.startsWith("git://") &&
				!split.repo.startsWith("git@");
			return {
				type: "git",
				repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
				host: info.domain || "",
				path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
				ref: info.committish || split.ref || undefined,
				pinned: Boolean(info.committish || split.ref),
			};
		}
	}

	const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : undefined, `https://${url}`].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of httpsCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			return {
				type: "git",
				repo: `https://${split.repo}`,
				host: info.domain || "",
				path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
				ref: info.committish || split.ref || undefined,
				pinned: Boolean(info.committish || split.ref),
			};
		}
	}

	return parseGenericGitUrl(url);
}

export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
export function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Snapshot of the repo state behind a session/turn, for correlating trajectories with code.
 * Fields are independently optional so partial reads still produce useful data.
 */
export interface GitContext {
	/** Normalized clone URL of the `origin` remote, if any. */
	repoUrl?: string;
	/** Full SHA of HEAD. */
	commit?: string;
	/** Current branch, or undefined on detached HEAD. */
	branch?: string;
}

export function gitContextsEqual(a: GitContext, b: GitContext): boolean {
	return a.repoUrl === b.repoUrl && a.commit === b.commit && a.branch === b.branch;
}

function readGitHead(headPath: string): { branch?: string; ref?: string; commit?: string } | null {
	let content: string;
	try {
		content = readFileSync(headPath, "utf8").trim();
	} catch {
		return null;
	}
	if (content.startsWith("ref:")) {
		const ref = content.slice(4).trim();
		const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
		return { ref, branch };
	}
	if (/^[0-9a-f]{40,64}$/.test(content)) {
		return { commit: content };
	}
	return null;
}

function resolveRef(commonGitDir: string, ref: string, depth = 0): string | undefined {
	if (depth > 8) return undefined;
	try {
		const content = readFileSync(join(commonGitDir, ref), "utf8").trim();
		if (content.startsWith("ref:")) return resolveRef(commonGitDir, content.slice(4).trim(), depth + 1);
		if (content) return content;
	} catch {
		// Loose ref absent; fall back to packed-refs.
	}
	try {
		const packed = readFileSync(join(commonGitDir, "packed-refs"), "utf8");
		for (const line of packed.split("\n")) {
			if (!line || line.startsWith("#") || line.startsWith("^")) continue;
			const sep = line.indexOf(" ");
			if (sep < 0) continue;
			if (line.slice(sep + 1).trim() === ref) return line.slice(0, sep).trim();
		}
	} catch {
		// No packed-refs.
	}
	return undefined;
}

function readOriginUrl(commonGitDir: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(join(commonGitDir, "config"), "utf8");
	} catch {
		return undefined;
	}
	let inOrigin = false;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inOrigin = /^\[remote\s+"origin"\]$/.test(line);
			continue;
		}
		if (inOrigin) {
			const match = line.match(/^url\s*=\s*(.+)$/);
			if (match?.[1]) {
				const url = match[1].trim();
				return parseGitUrl(url)?.repo ?? url;
			}
		}
	}
	return undefined;
}

/**
 * Read the repo's git state from .git without spawning git.
 * Returns null when cwd is not inside a git repo or nothing useful could be read.
 */
export function captureGitContext(cwd: string): GitContext | null {
	const paths = findGitPaths(cwd);
	if (!paths) return null;

	const head = readGitHead(paths.headPath);
	if (!head) return null;

	const commit = head.commit ?? (head.ref ? resolveRef(paths.commonGitDir, head.ref) : undefined);
	const repoUrl = readOriginUrl(paths.commonGitDir);

	const context: GitContext = {};
	if (repoUrl) context.repoUrl = repoUrl;
	if (commit) context.commit = commit;
	if (head.branch) context.branch = head.branch;

	if (!context.repoUrl && !context.commit && !context.branch) return null;
	return context;
}
