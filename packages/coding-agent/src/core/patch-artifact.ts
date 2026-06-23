import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { captureGitContext, type GitContext } from "../utils/git.js";
import type { SessionStats } from "./session-stats.js";

export type PatchArtifactStatus = "ready" | "empty" | "not_git_repo" | "rejected_setup_churn";

export interface PatchArtifactOptions {
	cwd: string;
	outputDir?: string;
	sessionFile?: string;
	sessionStats?: SessionStats;
	testsRun?: string[];
	failures?: string[];
	finalStatus?: string;
	allowSetupChurn?: boolean;
}

export interface PatchArtifactMetadata {
	version: 1;
	createdAt: string;
	cwd: string;
	git: GitContext | null;
	status: PatchArtifactStatus;
	files: {
		changed: string[];
		rejected: string[];
		untracked: string[];
	};
	patch: {
		path: string;
		bytes: number;
	};
	trajectory?: {
		path: string;
		source: string;
	};
	session?: SessionStats;
	testsRun: string[];
	failures: string[];
	finalStatus?: string;
}

export interface PatchArtifactResult {
	directory: string;
	patchPath: string;
	metadataPath: string;
	summaryPath: string;
	trajectoryPath?: string;
	status: PatchArtifactStatus;
	changedFiles: string[];
	rejectedFiles: string[];
	untrackedFiles: string[];
}

const SETUP_CHURN_FILENAMES = new Set([
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"Cargo.toml",
	"composer.json",
	"composer.lock",
	"go.mod",
	"go.sum",
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"poetry.lock",
	"pyproject.toml",
	"setup.cfg",
	"setup.py",
	"tox.ini",
	"uv.lock",
	"yarn.lock",
	"yarn.lock.yml",
]);

const SETUP_CHURN_PATH_PATTERNS = [
	/(^|\/)requirements(?:-[^/]*)?\.txt$/,
	/(^|\/)environment\.ya?ml$/,
	/(^|\/)conda\.ya?ml$/,
	/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
];

export function createPatchArtifact(options: PatchArtifactOptions): PatchArtifactResult {
	const cwd = resolve(options.cwd);
	const createdAt = new Date().toISOString();
	const artifactDir = resolveArtifactDir({
		cwd,
		outputDir: options.outputDir,
		sessionFile: options.sessionFile,
		createdAt,
	});

	const git = captureGitContext(cwd);
	const trackedPatch = git ? runGit(cwd, ["diff", "--binary", "HEAD", "--"]) : null;
	const trackedFiles = git ? parseGitLines(runGit(cwd, ["diff", "--name-only", "HEAD", "--"])?.stdout) : [];
	const untrackedFiles = git ? parseGitLines(runGit(cwd, ["ls-files", "--others", "--exclude-standard"])?.stdout) : [];
	const untrackedPatch = git ? collectUntrackedPatch(cwd, untrackedFiles) : "";
	const changedFiles = uniqueSorted([...trackedFiles, ...untrackedFiles]);
	const rejectedFiles = options.allowSetupChurn ? [] : changedFiles.filter(isSetupChurnPath);
	const patch = [trackedPatch?.stdout ?? "", untrackedPatch].filter((part) => part.trim().length > 0).join("\n");
	const status = getPatchStatus({
		hasGit: Boolean(git),
		hasPatch: patch.trim().length > 0,
		rejectedFiles,
	});

	mkdirSync(artifactDir, { recursive: true });
	const patchPath = join(artifactDir, "patch.diff");
	const metadataPath = join(artifactDir, "metadata.json");
	const summaryPath = join(artifactDir, "summary.md");
	writeFileSync(patchPath, patch ? `${patch.replace(/\s*$/, "")}\n` : "", "utf8");

	const trajectoryPath = copyTrajectory(options.sessionFile, artifactDir);
	const metadata: PatchArtifactMetadata = {
		version: 1,
		createdAt,
		cwd,
		git,
		status,
		files: {
			changed: changedFiles,
			rejected: rejectedFiles,
			untracked: untrackedFiles,
		},
		patch: {
			path: relative(artifactDir, patchPath),
			bytes: Buffer.byteLength(patch, "utf8"),
		},
		...(trajectoryPath
			? {
					trajectory: {
						path: relative(artifactDir, trajectoryPath),
						source: resolve(options.sessionFile!),
					},
				}
			: {}),
		...(options.sessionStats ? { session: options.sessionStats } : {}),
		testsRun: options.testsRun ?? [],
		failures: options.failures ?? [],
		...(options.finalStatus ? { finalStatus: options.finalStatus } : {}),
	};
	writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	writeFileSync(summaryPath, formatSummary(metadata), "utf8");

	return {
		directory: artifactDir,
		patchPath,
		metadataPath,
		summaryPath,
		trajectoryPath,
		status,
		changedFiles,
		rejectedFiles,
		untrackedFiles,
	};
}

function resolveArtifactDir(options: {
	cwd: string;
	outputDir?: string;
	sessionFile?: string;
	createdAt: string;
}): string {
	if (options.outputDir) {
		return isAbsolute(options.outputDir) ? options.outputDir : resolve(options.cwd, options.outputDir);
	}

	const safeTimestamp = options.createdAt.replace(/[:.]/g, "-");
	if (options.sessionFile) {
		return join(dirname(resolve(options.sessionFile)), "patch-artifacts", safeTimestamp);
	}
	return join(options.cwd, ".prime", "patch-artifacts", safeTimestamp);
}

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } | null {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	if (result.error) {
		return null;
	}
	return { status: result.status, stdout, stderr };
}

function parseGitLines(value: string | undefined): string[] {
	return (value ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function collectUntrackedPatch(cwd: string, files: string[]): string {
	const parts: string[] = [];
	for (const file of files) {
		const fullPath = resolve(cwd, file);
		if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
			continue;
		}
		const diff = runGit(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", file]);
		if (!diff || (diff.status !== 0 && diff.status !== 1) || !diff.stdout.trim()) {
			continue;
		}
		parts.push(diff.stdout);
	}
	return parts.join("\n");
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isSetupChurnPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	if (SETUP_CHURN_FILENAMES.has(basename(normalized))) {
		return true;
	}
	return SETUP_CHURN_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function getPatchStatus(options: { hasGit: boolean; hasPatch: boolean; rejectedFiles: string[] }): PatchArtifactStatus {
	if (!options.hasGit) {
		return "not_git_repo";
	}
	if (options.rejectedFiles.length > 0) {
		return "rejected_setup_churn";
	}
	if (!options.hasPatch) {
		return "empty";
	}
	return "ready";
}

function copyTrajectory(sessionFile: string | undefined, artifactDir: string): string | undefined {
	if (!sessionFile || !existsSync(sessionFile)) {
		return undefined;
	}
	const source = resolve(sessionFile);
	const target = join(artifactDir, "trajectory.jsonl");
	copyFileSync(source, target);
	return target;
}

function formatSummary(metadata: PatchArtifactMetadata): string {
	const lines = [
		"# Prime Agent Patch Artifact",
		"",
		`- status: ${metadata.status}`,
		`- cwd: ${metadata.cwd}`,
		`- commit: ${metadata.git?.commit ?? "-"}`,
		`- branch: ${metadata.git?.branch ?? "-"}`,
		`- changed files: ${metadata.files.changed.length}`,
		`- rejected setup files: ${metadata.files.rejected.length}`,
		`- untracked files: ${metadata.files.untracked.length}`,
		`- patch: ${metadata.patch.path}`,
		metadata.trajectory ? `- trajectory: ${metadata.trajectory.path}` : "- trajectory: -",
	];
	if (metadata.files.rejected.length > 0) {
		lines.push("", "## Rejected Files", "", ...metadata.files.rejected.map((file) => `- ${file}`));
	}
	return `${lines.join("\n")}\n`;
}
