import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_SCHEMA = 1;
const PYTHON_VERSION = "3.11";
const IPYKERNEL_REQUIREMENT = "ipykernel";
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";

interface BootstrapVersion {
	schema: number;
	ipykernel?: string;
	runtime?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function run(command: string, args: string[], options: { stdio?: "ignore" | "inherit" } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: process.env,
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
	return pythonImports(python, "rlm");
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

async function ensureUv(): Promise<string> {
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;

	const localUv = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
	if (await isExecutable(localUv)) return localUv;

	process.stderr.write("› installing uv (one-time)…\n");
	try {
		await run("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], { stdio: "inherit" });
	} catch (error) {
		throw new Error(
			`couldn't install uv from astral.sh; install it yourself: curl -LsSf https://astral.sh/uv/install.sh | sh, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	if (await isExecutable(localUv)) return localUv;
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath) return installedFromPath;
	throw new Error("uv install completed but binary not found at ~/.local/bin/uv");
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		return {
			schema: parsed.schema,
			ipykernel: typeof parsed.ipykernel === "string" ? parsed.ipykernel : undefined,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
		};
	} catch {
		return null;
	}
}

function bootstrapVersionCurrent(version: BootstrapVersion | null): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.ipykernel === IPYKERNEL_REQUIREMENT &&
		version.runtime === RUNTIME_REQUIREMENT
	);
}

async function writeBootstrapVersion(venv: string): Promise<void> {
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		ipykernel: IPYKERNEL_REQUIREMENT,
		runtime: RUNTIME_REQUIREMENT,
	};
	await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
}

function runtimeCandidateDirs(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	return [
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

async function resolveRuntimeRequirement(): Promise<string> {
	for (const candidate of runtimeCandidateDirs()) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return RUNTIME_REQUIREMENT;
}

async function bootstrapVenv(venv: string): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const uv = await ensureUv();
	const python = path.join(venv, "bin", "python");
	const runtimeRequirement = await resolveRuntimeRequirement();

	await run(uv, ["python", "install", PYTHON_VERSION]);
	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"]);
	await run(uv, ["pip", "install", "--python", python, IPYKERNEL_REQUIREMENT, runtimeRequirement]);
	await writeBootstrapVersion(venv);
}

async function kernelReady(python: string, venv: string): Promise<boolean> {
	return (
		(await hasIpykernel(python)) &&
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv))
	);
}

function formatBootstrapFailure(error: unknown): Error {
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, ipykernel, and prime-agent-runtime; once set up, prime-agent runs offline. " +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with ipykernel installed to skip auto-bootstrap.",
	);
}

export async function ensureKernelPython(): Promise<string> {
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		if (await hasIpykernel(python)) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python that cannot import ipykernel: ${python}`);
	}

	const venv = await resolveWritableKernelVenvDir();
	const python = path.join(venv, "bin", "python");
	if (await kernelReady(python, venv)) return python;

	const hadVenv = existsSync(venv);
	process.stderr.write("› setting up python kernel (one-time, ~30s)…\n");
	if (hadVenv) {
		process.stderr.write("rebuilding kernel venv\n");
		await rm(venv, { recursive: true, force: true });
	}

	try {
		await bootstrapVenv(venv);
	} catch (error) {
		throw formatBootstrapFailure(error);
	}

	process.stderr.write("✓ ready\n");
	return python;
}
