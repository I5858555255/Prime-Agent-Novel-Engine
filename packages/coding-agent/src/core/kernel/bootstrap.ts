import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";

const BOOTSTRAP_SCHEMA = 10;
const IPYKERNEL_REQUIREMENT = "ipykernel";
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
const KERNEL_LOCK_DIR = "kernel";
const KERNEL_LOCK_FILE = "uv.lock";
const KERNEL_PROJECT_FILE = "pyproject.toml";
const KERNEL_CONSTRAINTS_FILE = "constraints.txt";
const KERNEL_TOOLCHAIN_FILE = "toolchain.json";
const TERMUX_VENDOR_SCRIPT = "vendor_termux_packages.py";
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const REQUIRED_HARNESS_METHODS = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
	"record_refinement",
];
const RUNTIME_READY_CHECK = `import inspect; import rlm; from rlm import McpIntegration; from rlm.harness import HarnessEntry; _harness_methods = ${JSON.stringify(REQUIRED_HARNESS_METHODS)}; assert hasattr(rlm, 'run'); assert callable(rlm); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background')`;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 100;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;

let inFlightEnsureKernelPython: { key: string; promise: Promise<string> } | null = null;

export type KernelPythonSkill = PythonSkillRuntimeInfo;
export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
	pythonSkills?: readonly KernelPythonSkill[];
	onProgress?: KernelBootstrapProgressHandler;
}

interface BootstrapPythonSkill {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
	pyprojectHash: string;
}

interface BootstrapVersion {
	schema: number;
	ipykernel?: string;
	runtime?: string;
	snapshot?: string;
	kernelLock?: string;
	kernelPlatform?: string;
	pythonIdentity?: string;
	uvVersion?: string;
	extraUvArgs?: string[];
	pythonSkills?: BootstrapPythonSkill[];
}

interface KernelLock {
	projectDir: string;
	digest: string;
	platform: string;
	requireWheels: boolean;
	managedPython: string | null;
	toolchain: KernelToolchain;
}

interface KernelToolchain {
	managedPython: string;
	uv: string;
	excludeNewer: string;
	termuxPython: {
		minimum: string;
		maximumExclusive: string;
		validation: string;
		androidApiLevel: number;
		buildRequirements: string[];
		nativePackages: TermuxNativePackage[];
	};
}

interface TermuxNativePackage {
	systemPackage: string;
	packageVersion: string;
	distribution: string;
	version: string;
}

interface KernelToolIdentity {
	python: string;
	bootstrapPython: string;
	pythonIdentity: string;
	uv: string;
	uvVersion: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTermuxNativePackage(value: unknown): value is TermuxNativePackage {
	return (
		isRecord(value) &&
		typeof value.systemPackage === "string" &&
		typeof value.packageVersion === "string" &&
		typeof value.distribution === "string" &&
		typeof value.version === "string"
	);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function fileContentHash(filePath: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
	} catch {
		return "unreadable";
	}
}

function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	const addSkill = (skill: Pick<KernelPythonSkill, "importName" | "packagePath" | "pyprojectPath">): void => {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		if (byKey.has(key)) {
			return;
		}
		const bootstrapSkill: BootstrapPythonSkill = {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		byKey.set(key, bootstrapSkill);
		for (const dependencyName of readPythonSkillDependencyNames(bootstrapSkill)) {
			const siblingDependency = resolveSiblingPythonSkillDependency(bootstrapSkill, dependencyName);
			if (siblingDependency) {
				addSkill(siblingDependency);
			}
		}
	};
	for (const skill of pythonSkills ?? []) {
		addSkill(skill);
	}
	return [...byKey.values()].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}

function readTomlProjectSection(pyprojectPath: string): string | undefined {
	try {
		const text = readFileSync(pyprojectPath, "utf-8");
		const match = text.match(/^\s*\[project\]\s*$/m);
		if (!match || match.index === undefined) {
			return undefined;
		}
		const sectionStart = match.index + match[0].length;
		const rest = text.slice(sectionStart);
		const nextSection = rest.search(/^\s*\[/m);
		return nextSection >= 0 ? rest.slice(0, nextSection) : rest;
	} catch {
		return undefined;
	}
}

function readPythonSkillProjectName(skill: BootstrapPythonSkill): string {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	const name = projectSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
	return name?.trim() || skill.importName.replaceAll("_", "-");
}

function parseDependencyPackageName(dependency: string): string | undefined {
	const withoutMarker = dependency.split(";")[0]?.trim() ?? "";
	if (!withoutMarker) {
		return undefined;
	}
	const match = withoutMarker.match(/^([A-Za-z0-9_.-]+)/);
	return match?.[1]?.replaceAll("_", "-").toLowerCase();
}

function findTomlArrayEnd(text: string, startIndex: number): number {
	let inQuote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = startIndex; index < text.length; index++) {
		const char = text[index];
		if (inQuote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inQuote) {
				inQuote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "]") {
			return index;
		}
	}
	return -1;
}

function readPythonSkillDependencyNames(skill: BootstrapPythonSkill): Set<string> {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	if (!projectSection) {
		return new Set();
	}
	const dependenciesStart = projectSection.search(/^\s*dependencies\s*=\s*\[/m);
	if (dependenciesStart < 0) {
		return new Set();
	}
	const arrayStart = projectSection.indexOf("[", dependenciesStart);
	if (arrayStart < 0) {
		return new Set();
	}
	const arrayEnd = findTomlArrayEnd(projectSection, arrayStart + 1);
	if (arrayEnd < 0) {
		return new Set();
	}
	const dependenciesArray = projectSection.slice(arrayStart, arrayEnd + 1);
	const dependencies = new Set<string>();
	const dependencyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
	for (const match of dependenciesArray.matchAll(dependencyPattern)) {
		const dependency = (match[1] ?? match[2] ?? "").replaceAll('\\"', '"').replaceAll("\\'", "'");
		const name = parseDependencyPackageName(dependency);
		if (name) {
			dependencies.add(name);
		}
	}
	return dependencies;
}

function resolveSiblingPythonSkillDependency(
	skill: BootstrapPythonSkill,
	dependencyName: string,
): BootstrapPythonSkill | undefined {
	const siblingsDir = path.dirname(skill.packagePath);
	for (const entry of readdirSync(siblingsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packagePath = path.join(siblingsDir, entry.name);
		const pyprojectPath = path.join(packagePath, "pyproject.toml");
		if (!existsSync(pyprojectPath)) {
			continue;
		}
		const dependency: BootstrapPythonSkill = {
			importName: entry.name.replaceAll("-", "_"),
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		if (readPythonSkillProjectName(dependency).replaceAll("_", "-").toLowerCase() === dependencyName) {
			return dependency;
		}
	}
	return undefined;
}

function sortPythonSkillsForInstall(pythonSkills: readonly BootstrapPythonSkill[]): BootstrapPythonSkill[] {
	const byProjectName = new Map<string, BootstrapPythonSkill>();
	const originalIndex = new Map<BootstrapPythonSkill, number>();
	for (const [index, skill] of pythonSkills.entries()) {
		originalIndex.set(skill, index);
		byProjectName.set(readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill);
	}

	const dependenciesBySkill = new Map<BootstrapPythonSkill, BootstrapPythonSkill[]>();
	for (const skill of pythonSkills) {
		dependenciesBySkill.set(
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						byProjectName.get(dependencyName) ?? resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		);
	}

	const pending = new Set(pythonSkills);
	const sorted: BootstrapPythonSkill[] = [];
	while (pending.size > 0) {
		let progressed = false;
		for (const skill of [...pending].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))) {
			const dependencies = dependenciesBySkill.get(skill) ?? [];
			if (dependencies.some((dependency) => pending.has(dependency))) {
				continue;
			}
			sorted.push(skill);
			pending.delete(skill);
			progressed = true;
		}
		if (!progressed) {
			// Cyclic local skill dependencies cannot be topologically ordered; keep a
			// deterministic order and let uv surface the packaging error if needed.
			sorted.push(...[...pending].sort((a, b) => a.packagePath.localeCompare(b.packagePath)));
			break;
		}
	}
	return sorted;
}

function formatPythonSkillInstallArgs(skill: BootstrapPythonSkill): string[] {
	return ["--editable", skill.packagePath];
}

function ensureKernelPythonKey(pythonSkills: readonly BootstrapPythonSkill[]): string {
	return [
		process.env.PRIME_AGENT_KERNEL_PYTHON ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV ?? "",
		process.env.HOME ?? "",
		process.env.XDG_DATA_HOME ?? "",
		JSON.stringify(pythonSkills),
	].join("\0");
}

export function getKernelVenvDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(os.homedir(), ".prime", "agent", "kernel-venv");
}

function getXdgKernelVenvDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-venv");
}

async function resolveWritableKernelVenvDir(): Promise<string> {
	const primary = getKernelVenvDir();
	try {
		await mkdir(path.dirname(primary), { recursive: true });
		return primary;
	} catch (primaryError) {
		if (process.env.PRIME_AGENT_KERNEL_VENV) {
			throw new Error(`couldn't create kernel venv parent directory for ${primary}: ${errorMessage(primaryError)}`);
		}

		const fallback = getXdgKernelVenvDir();
		try {
			await mkdir(path.dirname(fallback), { recursive: true });
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				`couldn't create kernel venv directory at ${primary} or ${fallback}; set PRIME_AGENT_KERNEL_PYTHON to a python with ipykernel installed. ${errorMessage(fallbackError)}`,
			);
		}
	}
}

function run(
	command: string,
	args: string[],
	options: { stdio?: "ignore" | "inherit"; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: options.env ?? process.env,
			stdio: options.stdio ?? "ignore",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}`));
		});
	});
}

function runOutput(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}: ${stderr.trim()}`));
		});
	});
}

async function pythonImports(python: string, moduleName: string): Promise<boolean> {
	try {
		await run(python, ["-c", `import ${moduleName}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function hasIpykernel(python: string): Promise<boolean> {
	return pythonImports(python, "ipykernel");
}

async function hasPrimeAgentRuntime(python: string): Promise<boolean> {
	try {
		await run(python, ["-c", RUNTIME_READY_CHECK], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function missingRlmExtraImportLabels(python: string): Promise<string[]> {
	const missing: string[] = [];
	for (const pkg of DEFAULT_RLM_EXTRA_PACKAGES) {
		if (!(await pythonImports(python, pkg.importName))) {
			missing.push(pkg.promptLabel);
		}
	}
	return missing;
}

async function missingPythonSkillImportLabels(
	python: string,
	pythonSkills: readonly KernelPythonSkill[],
): Promise<string[]> {
	const missing: string[] = [];
	for (const skill of pythonSkills) {
		if (!(await pythonImports(python, skill.importName))) {
			missing.push(`${skill.name} (${skill.importName})`);
		}
	}
	return missing;
}

function reportProgress(options: EnsureKernelPythonOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function bootstrapLockDir(venv: string): string {
	return path.join(path.dirname(venv), `${path.basename(venv)}${BOOTSTRAP_LOCK_NAME}`);
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

async function readLockPid(lockDir: string): Promise<number | null> {
	try {
		const raw = await readFile(path.join(lockDir, "pid"), "utf8");
		const pid = Number.parseInt(raw.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

async function lockMissingPidIsStale(lockDir: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockDir);
		return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

async function acquireBootstrapLock(venv: string): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });

	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;

			const pid = await readLockPid(lockDir);
			if (pid === null ? await lockMissingPidIsStale(lockDir) : !processIsRunning(pid)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}

			await sleep(BOOTSTRAP_LOCK_RETRY_MS);
		}
	}
}

async function findExecutable(name: string): Promise<string | null> {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	const candidates = process.platform === "win32" ? [name, `${name}.exe`] : [name];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const fullPath = path.join(dir, candidate);
			if (await isExecutable(fullPath)) return fullPath;
		}
	}
	return null;
}

async function readUvVersion(uv: string): Promise<string | null> {
	try {
		const output = (await runOutput(uv, ["--version"])).trim();
		return output.match(/^uv (\S+)(?:\s|$)/)?.[1] ?? null;
	} catch {
		return null;
	}
}

async function ensureUv(options: EnsureKernelPythonOptions, requiredVersion: string): Promise<string> {
	const localUv = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
	const candidates = [await findExecutable("uv"), localUv];
	for (const candidate of candidates) {
		if (candidate && (await isExecutable(candidate)) && (await readUvVersion(candidate)) === requiredVersion) {
			return candidate;
		}
	}
	if (process.platform === "android") {
		throw new Error(
			`uv ${requiredVersion} is required on Termux. Install the documented Rust toolchain, then run ` +
				"scripts/install-termux-uv.sh from the Prime Agent repository",
		);
	}

	const installCommand = `curl -LsSf https://astral.sh/uv/${requiredVersion}/install.sh | sh`;

	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall()));
	if (!shouldInstallUv) {
		throw new Error(
			`uv ${requiredVersion} is required to set up the Python kernel. Install it yourself: ${installCommand}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	reportProgress(options, "› installing uv (one-time)…");
	try {
		await run("sh", ["-c", installCommand], { stdio: options.onProgress ? "ignore" : "inherit" });
	} catch (error) {
		throw new Error(
			`couldn't install uv ${requiredVersion} from astral.sh; install it yourself: ${installCommand}, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	if ((await isExecutable(localUv)) && (await readUvVersion(localUv)) === requiredVersion) return localUv;
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath && (await readUvVersion(installedFromPath)) === requiredVersion) return installedFromPath;
	throw new Error(`uv install completed but uv ${requiredVersion} was not found at ~/.local/bin/uv`);
}

async function confirmUvInstall(): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_UV === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;

	const rl = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (await rl.question("Prime Agent needs uv to set up Python. Install uv from astral.sh now? [Y/n] "))
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		rl.close();
	}
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		const extraUvArgs =
			Array.isArray(parsed.extraUvArgs) &&
			parsed.extraUvArgs.every((v: unknown): v is string => typeof v === "string")
				? (parsed.extraUvArgs as string[])
				: undefined;
		let pythonSkills: BootstrapPythonSkill[] | undefined;
		if (Array.isArray(parsed.pythonSkills)) {
			if (
				!parsed.pythonSkills.every((v: unknown): v is BootstrapPythonSkill => {
					if (!isRecord(v)) return false;
					return (
						typeof v.importName === "string" &&
						typeof v.packagePath === "string" &&
						typeof v.pyprojectPath === "string" &&
						typeof v.pyprojectHash === "string"
					);
				})
			) {
				return null;
			}
			pythonSkills = parsed.pythonSkills as BootstrapPythonSkill[];
		}
		return {
			schema: parsed.schema,
			ipykernel: typeof parsed.ipykernel === "string" ? parsed.ipykernel : undefined,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
			snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : undefined,
			kernelLock: typeof parsed.kernelLock === "string" ? parsed.kernelLock : undefined,
			kernelPlatform: typeof parsed.kernelPlatform === "string" ? parsed.kernelPlatform : undefined,
			pythonIdentity: typeof parsed.pythonIdentity === "string" ? parsed.pythonIdentity : undefined,
			uvVersion: typeof parsed.uvVersion === "string" ? parsed.uvVersion : undefined,
			extraUvArgs,
			pythonSkills,
		};
	} catch {
		return null;
	}
}

function extraUvArgsMatch(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function pythonSkillsMatch(a: BootstrapPythonSkill[] | undefined, b: readonly BootstrapPythonSkill[]): boolean {
	const left = a ?? [];
	if (left.length !== b.length) return false;
	return left.every((skill, index) => {
		const expected = b[index];
		return (
			skill.importName === expected.importName &&
			skill.packagePath === expected.packagePath &&
			skill.pyprojectPath === expected.pyprojectPath &&
			skill.pyprojectHash === expected.pyprojectHash
		);
	});
}

function bootstrapVersionCurrent(
	version: BootstrapVersion | null,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
	pythonSkills: readonly BootstrapPythonSkill[],
): boolean {
	return (
		version !== null &&
		bootstrapBaseVersionCurrent(version, runtimeIdentity, kernelLock, tools) &&
		pythonSkillsMatch(version.pythonSkills, pythonSkills)
	);
}

function bootstrapBaseVersionCurrent(
	version: BootstrapVersion | null,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.ipykernel === IPYKERNEL_REQUIREMENT &&
		version.runtime === runtimeIdentity &&
		version.snapshot === STATE_SNAPSHOT_REQUIREMENT &&
		version.kernelLock === kernelLock.digest &&
		version.kernelPlatform === kernelLock.platform &&
		version.pythonIdentity === tools.pythonIdentity &&
		version.uvVersion === tools.uvVersion &&
		extraUvArgsMatch(version.extraUvArgs, DEFAULT_RLM_EXTRA_UV_ARGS)
	);
}

async function writeBootstrapVersion(
	venv: string,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<void> {
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		ipykernel: IPYKERNEL_REQUIREMENT,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		kernelLock: kernelLock.digest,
		kernelPlatform: kernelLock.platform,
		pythonIdentity: tools.pythonIdentity,
		uvVersion: tools.uvVersion,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonSkills: [...pythonSkills],
	};
	await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
}

function runtimeCandidateDirs(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// dist/prime-agent-runtime is listed first deliberately: it is the only path stable
	// across every shipped layout (dist/, dist/bundle/, bun), where import.meta.url-relative
	// resolution breaks. `npm run build` rebuilds it from live source (copy-assets does
	// rm -rf + cp), so the staleness hash still refreshes on every build. The relative
	// paths below cover running from source (tsx) where dist/ hasn't been built.
	return [
		path.join(getPackageDir(), "dist", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

async function resolveRuntimeSourceDir(): Promise<string | null> {
	for (const candidate of runtimeCandidateDirs()) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return null;
}

function detectLinuxLibc(): "gnu" | "musl" {
	const report = process.report?.getReport();
	return isRecord(report) && isRecord(report.header) && typeof report.header.glibcVersionRuntime === "string"
		? "gnu"
		: "musl";
}

export function resolveKernelLockPlatform(
	platform = process.platform,
	arch = process.arch,
	linuxLibc: "gnu" | "musl" = detectLinuxLibc(),
): string {
	const target = `${platform}-${arch}`;
	switch (target) {
		case "darwin-arm64":
			return "aarch64-apple-darwin";
		case "darwin-x64":
			return "x86_64-apple-darwin";
		case "linux-arm64":
			return `aarch64-unknown-linux-${linuxLibc}`;
		case "linux-x64":
			return `x86_64-unknown-linux-${linuxLibc}`;
		case "win32-x64":
			return "x86_64-pc-windows-msvc";
		case "android-arm64":
			return "aarch64-linux-android";
		default:
			throw new Error(
				`the managed Python kernel is unavailable on ${target}; set PRIME_AGENT_KERNEL_PYTHON to a compatible environment`,
			);
	}
}

export function getKernelPythonPath(venv: string, platform = process.platform): string {
	return platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

async function resolveKernelLock(): Promise<KernelLock> {
	const sourceDir = await resolveRuntimeSourceDir();
	if (!sourceDir) {
		throw new Error("bundled prime-agent-runtime source is missing");
	}
	const projectDir = path.join(sourceDir, KERNEL_LOCK_DIR);
	const requiredFiles = [
		KERNEL_PROJECT_FILE,
		KERNEL_LOCK_FILE,
		KERNEL_CONSTRAINTS_FILE,
		KERNEL_TOOLCHAIN_FILE,
		TERMUX_VENDOR_SCRIPT,
	];
	if (!(await Promise.all(requiredFiles.map((file) => exists(path.join(projectDir, file))))).every(Boolean)) {
		throw new Error(`bundled Python kernel lock is missing from ${projectDir}`);
	}
	const toolchainValue: unknown = JSON.parse(await readFile(path.join(projectDir, KERNEL_TOOLCHAIN_FILE), "utf8"));
	if (
		!isRecord(toolchainValue) ||
		typeof toolchainValue.managedPython !== "string" ||
		typeof toolchainValue.uv !== "string" ||
		typeof toolchainValue.excludeNewer !== "string" ||
		!isRecord(toolchainValue.termuxPython) ||
		typeof toolchainValue.termuxPython.minimum !== "string" ||
		typeof toolchainValue.termuxPython.maximumExclusive !== "string" ||
		typeof toolchainValue.termuxPython.validation !== "string" ||
		typeof toolchainValue.termuxPython.androidApiLevel !== "number" ||
		!Number.isInteger(toolchainValue.termuxPython.androidApiLevel) ||
		!Array.isArray(toolchainValue.termuxPython.buildRequirements) ||
		!toolchainValue.termuxPython.buildRequirements.every((requirement) => typeof requirement === "string") ||
		!Array.isArray(toolchainValue.termuxPython.nativePackages) ||
		!toolchainValue.termuxPython.nativePackages.every(isTermuxNativePackage)
	) {
		throw new Error(`bundled Python kernel toolchain is invalid in ${projectDir}`);
	}
	const hash = createHash("sha256");
	for (const file of requiredFiles) {
		hash.update(file);
		hash.update("\0");
		hash.update(await readFile(path.join(projectDir, file)));
		hash.update("\0");
	}
	return {
		projectDir,
		digest: `sha256:${hash.digest("hex")}`,
		platform: resolveKernelLockPlatform(),
		requireWheels: process.platform !== "android",
		managedPython: process.platform === "android" ? null : toolchainValue.managedPython,
		toolchain: toolchainValue as unknown as KernelToolchain,
	};
}

export async function resolveKernelLockDigest(): Promise<string> {
	return (await resolveKernelLock()).digest;
}

// Identity of the runtime to be installed. For a local source checkout this is a
// content hash of every rlm/*.py file plus pyproject.toml, so any runtime code or
// dependency change invalidates an existing venv automatically. Falls back to the
// bare package name when the runtime resolves to a registry install (no local source).
export async function resolveRuntimeIdentity(): Promise<string> {
	const sourceDir = await resolveRuntimeSourceDir();
	if (!sourceDir) return RUNTIME_REQUIREMENT;
	return hashRuntimeSource(sourceDir);
}

// Throws if the local source can't be read. A failure here must surface rather than
// fall back to RUNTIME_REQUIREMENT: that constant is the registry-install identity, and
// recording it for a local checkout would permanently mask later source changes.
async function hashRuntimeSource(sourceDir: string): Promise<string> {
	const rlmDir = path.join(sourceDir, "src", "rlm");
	const files: string[] = [path.join(sourceDir, "pyproject.toml")];
	async function collect(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await collect(full);
			} else if (entry.isFile() && entry.name.endsWith(".py")) {
				files.push(full);
			}
		}
	}
	await collect(rlmDir);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(sourceDir, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function versionParts(version: string): number[] {
	return version.split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(left: string, right: string): number {
	const leftParts = versionParts(left);
	const rightParts = versionParts(right);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

async function resolveKernelTools(
	venv: string,
	kernelLock: KernelLock,
	options: EnsureKernelPythonOptions,
): Promise<KernelToolIdentity> {
	const uv = await ensureUv(options, kernelLock.toolchain.uv);
	const uvVersion = await readUvVersion(uv);
	if (uvVersion !== kernelLock.toolchain.uv) {
		throw new Error(`expected uv ${kernelLock.toolchain.uv}, found ${uvVersion ?? "an unreadable version"}`);
	}
	const python = getKernelPythonPath(venv);
	if (kernelLock.managedPython) {
		return {
			python,
			bootstrapPython: kernelLock.managedPython,
			pythonIdentity: `managed:${kernelLock.managedPython}`,
			uv,
			uvVersion,
		};
	}

	const systemPython = await findExecutable("python");
	if (!systemPython) {
		throw new Error("Termux system Python is required; run pkg install python or set PRIME_AGENT_KERNEL_PYTHON");
	}
	const output = (await runOutput(systemPython, ["--version"])).trim();
	const pythonVersion = output.match(/^Python (\d+\.\d+\.\d+)/)?.[1];
	if (
		!pythonVersion ||
		compareVersions(pythonVersion, kernelLock.toolchain.termuxPython.minimum) < 0 ||
		compareVersions(pythonVersion, kernelLock.toolchain.termuxPython.maximumExclusive) >= 0
	) {
		throw new Error(
			`Termux Python ${pythonVersion ?? "version could not be read"} is outside the supported range ` +
				`>=${kernelLock.toolchain.termuxPython.minimum},<${kernelLock.toolchain.termuxPython.maximumExclusive}; ` +
				"set PRIME_AGENT_KERNEL_PYTHON to a compatible environment",
		);
	}
	const missingTools: string[] = [];
	for (const tool of ["cargo", "clang", "cmake", "dpkg-query", "make", "ninja", "pkg-config", "rustc"]) {
		if (!(await findExecutable(tool))) missingTools.push(tool);
	}
	if (missingTools.length > 0) {
		throw new Error(
			`Termux kernel builds require ${missingTools.join(", ")}; install the documented Termux toolchain or set PRIME_AGENT_KERNEL_PYTHON`,
		);
	}
	const nativePackageIdentities: string[] = [];
	for (const nativePackage of kernelLock.toolchain.termuxPython.nativePackages) {
		let packageVersion: string;
		try {
			packageVersion = (
				await runOutput("dpkg-query", ["-W", "-f=\u0024{Version}", nativePackage.systemPackage])
			).trim();
		} catch {
			throw new Error(
				`Termux kernel builds require ${nativePackage.systemPackage}=${nativePackage.packageVersion}; ` +
					"install the exact documented native packages before starting Prime Agent",
			);
		}
		if (packageVersion !== nativePackage.packageVersion) {
			throw new Error(
				`expected Termux ${nativePackage.systemPackage} ${nativePackage.packageVersion}, found ${packageVersion}; ` +
					"review and refresh the kernel toolchain before using a newer native package",
			);
		}
		const distributionVersion = (
			await runOutput(systemPython, [
				"-c",
				"from importlib.metadata import version; import sys; print(version(sys.argv[1]))",
				nativePackage.distribution,
			])
		).trim();
		if (distributionVersion !== nativePackage.version) {
			throw new Error(
				`expected Termux ${nativePackage.distribution} ${nativePackage.version}, found ${distributionVersion}`,
			);
		}
		nativePackageIdentities.push(`${nativePackage.systemPackage}@${packageVersion}`);
	}
	return {
		python,
		bootstrapPython: systemPython,
		pythonIdentity: `system:${systemPython}@${pythonVersion};${nativePackageIdentities.join(",")}`,
		uv,
		uvVersion,
	};
}

async function validateKernelLock(kernelLock: KernelLock, tools: KernelToolIdentity): Promise<void> {
	await run(tools.uv, [
		"lock",
		"--project",
		kernelLock.projectDir,
		"--python",
		kernelLock.toolchain.managedPython,
		"--exclude-newer",
		kernelLock.toolchain.excludeNewer,
		"--check",
	]);
	const exported = await runOutput(tools.uv, [
		"export",
		"--project",
		kernelLock.projectDir,
		"--locked",
		"--no-dev",
		"--no-emit-project",
		"--no-header",
		"--no-hashes",
		"--python",
		kernelLock.toolchain.managedPython,
		"--exclude-newer",
		kernelLock.toolchain.excludeNewer,
	]);
	const constraints = await readFile(path.join(kernelLock.projectDir, KERNEL_CONSTRAINTS_FILE), "utf8");
	if (exported !== constraints) {
		throw new Error("bundled kernel constraints do not match uv.lock");
	}
	const constraintLines = constraints.split("\n");
	for (const nativePackage of kernelLock.toolchain.termuxPython.nativePackages) {
		const expected = `${nativePackage.distribution}==${nativePackage.version}`;
		if (!constraintLines.some((line) => line === expected || line.startsWith(`${expected} `))) {
			throw new Error(`Termux native package ${expected} does not match the bundled kernel lock`);
		}
	}
}

function kernelEnvironment(kernelLock: KernelLock, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		...(kernelLock.managedPython
			? {}
			: { ANDROID_API_LEVEL: String(kernelLock.toolchain.termuxPython.androidApiLevel) }),
		...extra,
	};
}

async function vendorTermuxPackages(kernelLock: KernelLock, tools: KernelToolIdentity, python: string): Promise<void> {
	if (kernelLock.managedPython) return;
	await run(tools.bootstrapPython, [path.join(kernelLock.projectDir, TERMUX_VENDOR_SCRIPT), python], {
		env: kernelEnvironment(kernelLock),
	});
}

async function installTermuxBuildRequirements(
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
	python: string,
): Promise<void> {
	if (kernelLock.managedPython) return;
	await run(
		tools.uv,
		[
			"pip",
			"install",
			"--python",
			python,
			"--constraint",
			path.join(kernelLock.projectDir, KERNEL_CONSTRAINTS_FILE),
			...kernelLock.toolchain.termuxPython.buildRequirements,
		],
		{ env: kernelEnvironment(kernelLock) },
	);
}

async function bootstrapVenv(
	venv: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const python = getKernelPythonPath(venv);
	const sourceDir = await resolveRuntimeSourceDir();
	const runtimeRequirement = sourceDir ?? RUNTIME_REQUIREMENT;
	const runtimeIdentity = await resolveRuntimeIdentity();

	if (kernelLock.managedPython) {
		await run(tools.uv, ["python", "install", kernelLock.managedPython]);
	}
	await run(tools.uv, ["venv", venv, "--python", tools.bootstrapPython, "--seed", "--relocatable"]);
	await vendorTermuxPackages(kernelLock, tools, python);
	await installTermuxBuildRequirements(kernelLock, tools, python);
	const wheelArgs = kernelLock.requireWheels ? ["--no-build"] : [];
	await run(
		tools.uv,
		[
			"sync",
			"--project",
			kernelLock.projectDir,
			"--locked",
			"--active",
			"--no-dev",
			"--no-install-project",
			...wheelArgs,
			...(kernelLock.managedPython ? [] : ["--no-build-isolation-package", "pandas"]),
			"--exclude-newer",
			kernelLock.toolchain.excludeNewer,
			"--python-platform",
			kernelLock.platform,
		],
		{
			env: kernelEnvironment(kernelLock, { VIRTUAL_ENV: venv }),
		},
	);
	await run(
		tools.uv,
		["pip", "install", "--python", python, "--no-build-isolation", "--no-deps", runtimeRequirement],
		{
			env: kernelEnvironment(kernelLock),
		},
	);
	await syncPythonSkills(tools, venv, python, runtimeIdentity, kernelLock, pythonSkills, options);
}

async function syncPythonSkills(
	tools: KernelToolIdentity,
	venv: string,
	python: string,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	const version = await readBootstrapVersion(venv);
	const installedPythonSkills: BootstrapPythonSkill[] = [];
	const currentPythonSkills = new Map(
		(version?.pythonSkills ?? []).map((skill) => [`${skill.importName}\0${skill.packagePath}`, skill]),
	);
	const requestedSkillKeys = new Set(pythonSkills.map((skill) => `${skill.importName}\0${skill.packagePath}`));
	for (const installedSkill of version?.pythonSkills ?? []) {
		if (!requestedSkillKeys.has(`${installedSkill.importName}\0${installedSkill.packagePath}`)) {
			await run(tools.uv, ["pip", "uninstall", "--python", python, readPythonSkillProjectName(installedSkill)]);
		}
	}
	const pythonSkillsByProjectName = new Map(
		pythonSkills.map((skill) => [readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill]),
	);
	const dependenciesBySkill = new Map(
		pythonSkills.map((skill) => [
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						pythonSkillsByProjectName.get(dependencyName) ??
						resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		]),
	);

	for (const skill of sortPythonSkillsForInstall(pythonSkills)) {
		const existingSkill = currentPythonSkills.get(`${skill.importName}\0${skill.packagePath}`);
		if (existingSkill?.pyprojectPath === skill.pyprojectPath && existingSkill.pyprojectHash === skill.pyprojectHash) {
			installedPythonSkills.push(skill);
			continue;
		}

		const localDependencies = dependenciesBySkill.get(skill) ?? [];
		const localDependencyArgs = localDependencies
			.filter((dependency) => {
				const installedDependency = currentPythonSkills.get(`${dependency.importName}\0${dependency.packagePath}`);
				const installedThisSync = installedPythonSkills.some(
					(installed) =>
						installed.importName === dependency.importName &&
						installed.packagePath === dependency.packagePath &&
						installed.pyprojectPath === dependency.pyprojectPath &&
						installed.pyprojectHash === dependency.pyprojectHash,
				);
				return !(
					installedThisSync ||
					(installedDependency?.pyprojectPath === dependency.pyprojectPath &&
						installedDependency.pyprojectHash === dependency.pyprojectHash)
				);
			})
			.flatMap(formatPythonSkillInstallArgs);

		try {
			await run(
				tools.uv,
				[
					"pip",
					"install",
					"--python",
					python,
					"--constraint",
					path.join(kernelLock.projectDir, KERNEL_CONSTRAINTS_FILE),
					...formatPythonSkillInstallArgs(skill),
					...localDependencyArgs,
				],
				{ env: kernelEnvironment(kernelLock) },
			);
			installedPythonSkills.push(
				skill,
				...localDependencies.filter((dependency) => !installedPythonSkills.includes(dependency)),
			);
		} catch (error) {
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
	}
	await run(
		tools.uv,
		[
			"sync",
			"--project",
			kernelLock.projectDir,
			"--locked",
			"--active",
			"--no-dev",
			"--no-install-project",
			"--inexact",
			...(kernelLock.requireWheels ? ["--no-build"] : []),
			...(kernelLock.managedPython ? [] : ["--no-build-isolation-package", "pandas"]),
			"--exclude-newer",
			kernelLock.toolchain.excludeNewer,
			"--python-platform",
			kernelLock.platform,
		],
		{ env: kernelEnvironment(kernelLock, { VIRTUAL_ENV: venv }) },
	);
	await run(tools.uv, ["pip", "check", "--python", python]);
	await writeBootstrapVersion(venv, runtimeIdentity, kernelLock, tools, installedPythonSkills);
}

async function kernelBaseReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
): Promise<boolean> {
	return (
		(await hasIpykernel(python)) &&
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapBaseVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, kernelLock, tools)
	);
}

async function kernelReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<boolean> {
	return (
		(await hasIpykernel(python)) &&
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, kernelLock, tools, pythonSkills)
	);
}

function stagingVenv(venv: string): string {
	return `${venv}.next`;
}

function previousVenv(venv: string): string {
	return `${venv}.previous`;
}

async function recoverInterruptedSwap(
	venv: string,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<void> {
	const previous = previousVenv(venv);
	if (!(await exists(venv)) && (await exists(previous))) {
		await rename(previous, venv);
	}
	if ((await exists(venv)) && (await exists(previous))) {
		if (await kernelReady(getKernelPythonPath(venv), venv, runtimeIdentity, kernelLock, tools, pythonSkills)) {
			await rm(previous, { recursive: true, force: true });
		} else {
			await rm(venv, { recursive: true, force: true });
			await rename(previous, venv);
		}
	}
	await rm(stagingVenv(venv), { recursive: true, force: true });
}

async function replaceKernelVenv(
	venv: string,
	runtimeIdentity: string,
	kernelLock: KernelLock,
	tools: KernelToolIdentity,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	const staging = stagingVenv(venv);
	const previous = previousVenv(venv);
	await rm(staging, { recursive: true, force: true });
	try {
		await bootstrapVenv(staging, kernelLock, tools, pythonSkills, options);
		if (!(await kernelBaseReady(getKernelPythonPath(staging), staging, runtimeIdentity, kernelLock, tools))) {
			throw new Error("new kernel environment failed validation before activation");
		}
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}

	await rm(previous, { recursive: true, force: true });
	const hadVenv = await exists(venv);
	if (hadVenv) await rename(venv, previous);
	try {
		await rename(staging, venv);
		if (!(await kernelBaseReady(getKernelPythonPath(venv), venv, runtimeIdentity, kernelLock, tools))) {
			throw new Error("new kernel environment failed validation after activation");
		}
		await rm(previous, { recursive: true, force: true });
	} catch (error) {
		await rm(venv, { recursive: true, force: true });
		if (hadVenv && (await exists(previous))) await rename(previous, venv);
		throw error;
	}
}

function formatBootstrapFailure(error: unknown): Error {
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, ipykernel, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. " +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with ipykernel, a current prime-agent-runtime, and default Python packages installed to skip auto-bootstrap.",
	);
}

async function ensureKernelPythonUncached(
	options: EnsureKernelPythonOptions,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		const missing: string[] = [];
		if (!(await hasIpykernel(python))) missing.push("ipykernel");
		if (!(await hasPrimeAgentRuntime(python))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? []);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}

	const venv = await resolveWritableKernelVenvDir();
	const python = getKernelPythonPath(venv);
	const runtimeIdentity = await resolveRuntimeIdentity();
	const kernelLock = await resolveKernelLock();
	const tools = await resolveKernelTools(venv, kernelLock, options);
	await validateKernelLock(kernelLock, tools);
	if (
		!(await exists(previousVenv(venv))) &&
		!(await exists(stagingVenv(venv))) &&
		(await kernelReady(python, venv, runtimeIdentity, kernelLock, tools, pythonSkills))
	) {
		return python;
	}

	const releaseLock = await acquireBootstrapLock(venv);
	try {
		await recoverInterruptedSwap(venv, runtimeIdentity, kernelLock, tools, pythonSkills);
		if (await kernelReady(python, venv, runtimeIdentity, kernelLock, tools, pythonSkills)) return python;
		if (await kernelBaseReady(python, venv, runtimeIdentity, kernelLock, tools)) {
			await syncPythonSkills(tools, venv, python, runtimeIdentity, kernelLock, pythonSkills, options);
			return python;
		}

		const hadVenv = existsSync(venv);
		reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
		if (hadVenv) reportProgress(options, "rebuilding kernel venv");
		await replaceKernelVenv(venv, runtimeIdentity, kernelLock, tools, pythonSkills, options);
	} catch (error) {
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}

	reportProgress(options, "✓ ready");
	return python;
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const key = ensureKernelPythonKey(pythonSkills);
	if (inFlightEnsureKernelPython?.key === key) return inFlightEnsureKernelPython.promise;

	const promise = ensureKernelPythonUncached(options, pythonSkills).finally(() => {
		if (inFlightEnsureKernelPython?.promise === promise) inFlightEnsureKernelPython = null;
	});
	inFlightEnsureKernelPython = { key, promise };
	return promise;
}
