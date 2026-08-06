import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const source = readFileSync("install.ps1", "utf8").replace(/^\uFEFF/, "");
const shellSource = readFileSync("install.sh", "utf8");
const baseUrlPlaceholder = "__PRIME_AGENT_DOWNLOAD_BASE_URL__";
const channelPlaceholder = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__";
const mainCall = "\ntry {\n";
const mainCallIndex = source.lastIndexOf(mainCall);
const shellMainCall = '\nmain "$@"';
const shellMainCallIndex = shellSource.lastIndexOf(shellMainCall);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const failures = [];

check(source.includes(baseUrlPlaceholder), "missing download base URL placeholder");
check(source.includes(channelPlaceholder), "missing default release channel placeholder");
check(source.includes("Security.Cryptography.SHA256"), "installer must verify downloads with SHA-256");
check(source.includes('OpenJS.NodeJS.LTS'), "installer must offer Node.js installation");
check(source.includes('Git.Git'), "installer must offer Git Bash installation");
check(source.includes("▄▄███▀"), "installer must include Prime Agent logo");
check(source.includes("$syncStart"), "installer must use synchronized terminal updates");
check(mainCallIndex !== -1, "could not find final installer invocation");
check(shellMainCallIndex !== -1, "could not find final shell installer invocation");

const exampleBaseUrl = ["https:", "", "downloads.example.test"].join("/");
for (const channel of ["stable", "beta"]) {
	const rendered = source.replaceAll(baseUrlPlaceholder, exampleBaseUrl).replaceAll(channelPlaceholder, channel);
	check(!rendered.includes(baseUrlPlaceholder), `${channel} render retained base URL placeholder`);
	check(!rendered.includes(channelPlaceholder), `${channel} render retained channel placeholder`);
}

const shellReferenceFrame = getShellReferenceFrame();
const powershellCommands = findPowerShellCommands();
if (powershellCommands.length > 0) {
	for (const command of powershellCommands) {
		await runRenderCheck(command);
		await runEndToEndCheck(command);
	}
} else {
	process.stdout.write("PowerShell unavailable; skipped Windows installer execution check.\n");
}

if (failures.length > 0) {
	process.stderr.write(`${["Windows installer check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n")}\n`);
	process.exit(1);
}

process.stdout.write("Windows installer check passed.\n");

function getShellReferenceFrame() {
	if (shellMainCallIndex === -1) return undefined;
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-shell-render-"));
	const harnessPath = join(tempDir, "render.sh");
	const harness = `${shellSource.slice(0, shellMainCallIndex)}

prime_agent_screen_cols=100
prime_agent_screen_rows=30
prime_agent_screen_layout_ready=0
prime_agent_screen_layout_show_logo=0
prime_agent_screen_layout_lab_width=0
prime_agent_screen_render_lab_width=0
prime_agent_screen_compact=0
prime_agent_screen_frame=1
prime_agent_screen_title="Installing Prime Agent"
prime_agent_screen_detail="Fetching the verified package."
prime_agent_screen_question=
prime_agent_init_screen_layout
prime_agent_refresh_screen_layout_mode
prime_agent_render_screen
`;
	try {
		writeFileSync(harnessPath, harness);
		const result = spawnSync("sh", [harnessPath], { encoding: "utf8" });
		check(result.status === 0, `shell render harness exited with ${result.status}\n${result.stderr}${result.stdout}`);
		if (result.status !== 0) return undefined;
		return result.stdout.replace(ansiPattern, "").replace(/\n$/, "");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function findPowerShellCommands() {
	return ["pwsh", "powershell"].filter((command) => {
		const result = spawnSync(command, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
			encoding: "utf8",
		});
		return result.status === 0;
	});
}

async function runRenderCheck(command) {
	if (mainCallIndex === -1) return;
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-windows-render-"));
	const harnessPath = join(tempDir, "render.ps1");
	const harness = `${source.slice(0, mainCallIndex)}

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

function Get-TestRender {
	param(
		[int]$InitialCols,
		[int]$InitialRows,
		[int]$ResizedCols,
		[int]$ResizedRows
	)

	$script:InstallerScreenLayoutReady = $false
	$script:InstallerScreenLayoutShowLogo = $false
	$script:InstallerScreenLayoutLabWidth = 0
	$script:InstallerScreenRenderLabWidth = 0
	$script:InstallerScreenCompact = $false
	$script:InstallerScreenFrame = 1
	$script:InstallerScreenTitle = "Installing Prime Agent"
	$script:InstallerScreenDetail = "Fetching the verified package."
	$script:InstallerScreenQuestion = ""
	$script:InstallerScreenCols = $InitialCols
	$script:InstallerScreenRows = $InitialRows
	Initialize-InstallerScreenLayout
	Select-InstallerScreenLayoutMode
	$firstFrame = Get-InstallerScreenFrameText
	$firstLines = $firstFrame -split "\n"
	$first = [pscustomobject]@{
		visible = Test-InstallerLogoVisible
		compact = $script:InstallerScreenCompact
		labWidth = $script:InstallerScreenLayoutLabWidth
		renderLabWidth = $script:InstallerScreenRenderLabWidth
		lineCount = $firstLines.Count
		maxWidth = ($firstLines | ForEach-Object { [regex]::Replace($_, "\\x1b\\[[0-?]*[ -/]*[@-~]", "").Length } | Measure-Object -Maximum).Maximum
		containsLogo = $firstFrame.Contains("▄")
		plainFrame = [regex]::Replace($firstFrame, "\\x1b\\[[0-?]*[ -/]*[@-~]", "")
	}

	$script:InstallerScreenFrame = 2
	$script:InstallerScreenCols = $ResizedCols
	$script:InstallerScreenRows = $ResizedRows
	Select-InstallerScreenLayoutMode
	$secondFrame = Get-InstallerScreenFrameText
	$secondLines = $secondFrame -split "\n"
	$second = [pscustomobject]@{
		visible = Test-InstallerLogoVisible
		compact = $script:InstallerScreenCompact
		labWidth = $script:InstallerScreenLayoutLabWidth
		renderLabWidth = $script:InstallerScreenRenderLabWidth
		lineCount = $secondLines.Count
		maxWidth = ($secondLines | ForEach-Object { [regex]::Replace($_, "\\x1b\\[[0-?]*[ -/]*[@-~]", "").Length } | Measure-Object -Maximum).Maximum
		containsLogo = $secondFrame.Contains("▄")
	}
	return [pscustomobject]@{ first = $first; second = $second }
}

$details = @("Preparing global install.", "Linking command binaries.", "Finalizing npm install.")
$progress = foreach ($frame in @(1, 24, 25, 48, 49, 200)) {
	$script:InstallerAnimationFrame = $frame
	Get-InstallerAnimationDetail $details
}
$script:InstallerScreenEnabled = $true
$script:TestAnimationCalls = 0
function Show-InstallerScreen {
	param([string]$Title, [string]$Detail = "", [string]$Question = "")
	$script:TestAnimationCalls += 1
}
function Restore-InstallerTerminal {}
Invoke-InstallerNativeCommand -Title "Testing animation" -Status "Testing animation" -Details $details \`
	-FilePath '${command.replaceAll("'", "''")}' -Arguments @("-NoProfile", "-Command", "Start-Sleep -Milliseconds 400")

$result = [pscustomobject]@{
	stable = Get-TestRender 100 30 90 30
	expanded = Get-TestRender 60 24 120 32
	noLogo = Get-TestRender 41 24 100 30
	compactWidth = Get-TestRender 100 30 32 24
	compactRows = Get-TestRender 100 30 100 10
	progress = $progress
	animationCalls = $script:TestAnimationCalls
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
`;

	try {
		writeFileSync(harnessPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(harness)]));
		const env = {
			...process.env,
			PRIME_AGENT_DOWNLOAD_BASE_URL: exampleBaseUrl,
		};
		const result = await run(command, ["-NoProfile", "-File", harnessPath], env);
		check(result.code === 0, `render harness exited with ${result.code}\n${result.stderr}${result.stdout}`);
		if (result.code !== 0) return;
		const render = JSON.parse(result.stdout.trim());
		check(render.stable.first.visible, "large Windows render must show logo");
		check(render.stable.second.visible, "safe Windows resize must retain logo");
		check(render.stable.first.containsLogo, "large Windows render must contain logo glyphs");
		check(render.stable.first.labWidth === render.stable.second.labWidth, "Windows logo width must remain stable after resize");
		check(render.stable.first.lineCount === 30, "large Windows render must fill terminal rows");
		check(render.stable.first.maxWidth <= 99, "large Windows render must fit terminal width");
		if (shellReferenceFrame) {
			const windowsLines = render.stable.first.plainFrame.split("\n");
			const shellLines = shellReferenceFrame.split("\n");
			const mismatch = windowsLines.findIndex((line, index) => line !== shellLines[index]);
			check(
				mismatch === -1 && windowsLines.length === shellLines.length,
				`Windows and shell installer frames must match; first mismatch line ${mismatch + 1}: ${JSON.stringify(windowsLines[mismatch])} != ${JSON.stringify(shellLines[mismatch])}`,
			);
		}
		check(render.expanded.first.labWidth === render.expanded.second.labWidth, "Windows logo width must not grow after expansion");
		check(!render.noLogo.first.visible && !render.noLogo.second.visible, "small initial Windows terminal must remain text-only");
		check(render.compactWidth.second.compact && !render.compactWidth.second.visible, "severe Windows width shrink must hide logo");
		check(render.compactRows.second.compact && !render.compactRows.second.visible, "short Windows terminal must hide logo");
		check(render.animationCalls > 0, "Windows native command animation must redraw while child runs");
		check(
			JSON.stringify(render.progress) ===
				JSON.stringify([
					"Preparing global install.",
					"Preparing global install.",
					"Linking command binaries.",
					"Linking command binaries.",
					"Finalizing npm install.",
					"Finalizing npm install.",
				]),
			"Windows progress details must advance deterministically",
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function runEndToEndCheck(command) {
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-windows-installer-"));
	const binDir = join(tempDir, "bin");
	const npmLog = join(tempDir, "npm.log");
	const shellPath = join(tempDir, "bash.exe");
	const version = "1.2.3";
	const tarballName = `prime-agent-${version}.tgz`;
	const tarball = Buffer.from("prime-agent-test-tarball");
	const checksum = createHash("sha256").update(tarball).digest("hex");

	try {
		mkdirSync(binDir, { recursive: true });
		writeFileSync(shellPath, "test shell");
		writeFakeCommands(binDir, npmLog);
		const settingsDir = join(tempDir, ".prime", "agent");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(join(settingsDir, "settings.json"), `${JSON.stringify({ shellPath })}\n`);

		const server = createServer((request, response) => {
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			switch (request.url) {
				case "/stable":
					response.end(`v${version}\n`);
					break;
				case `/releases/v${version}/SHA256SUMS`:
					response.end(`${checksum}  ${tarballName}\n`);
					break;
				case `/releases/v${version}/${tarballName}`:
					response.end(tarball);
					break;
				default:
					response.statusCode = 404;
					response.end("not found");
			}
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
			const testBaseUrl = `http://127.0.0.1:${address.port}`;
			const installerPath = join(tempDir, "install.ps1");
			const renderedInstaller = source
				.replaceAll(baseUrlPlaceholder, testBaseUrl)
				.replaceAll(channelPlaceholder, "stable");
			writeFileSync(
				installerPath,
				Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(renderedInstaller)]),
			);
			const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
			const env = {
				...process.env,
				HOME: tempDir,
				OS: "Windows_NT",
				PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
				PRIME_AGENT_TEST_NPM_LOG: npmLog,
				USERPROFILE: tempDir,
				[pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ""}`,
			};
			delete env.PRIME_AGENT_DOWNLOAD_BASE_URL;
			delete env.PRIME_AGENT_RELEASE_CHANNEL;
			delete env.PRIME_AGENT_VERSION;
			const result = await run(command, ["-NoProfile", "-File", installerPath], env, "y\n");
			check(result.code === 0, `installer execution exited with ${result.code}\n${result.stderr}${result.stdout}`);
			if (result.code === 0) {
				check(!result.stdout.includes("\u001b[?2026h"), "redirected installer must not emit terminal control sequences");
				const npmInvocation = readFileSync(npmLog, "utf8");
				check(npmInvocation.includes("install -g"), `installer did not run npm install -g: ${npmInvocation}`);
				check(npmInvocation.includes(tarballName), `installer did not pass downloaded tarball to npm: ${npmInvocation}`);
				check(npmInvocation.includes("TOOLS=1"), `installer did not bootstrap required tools: ${npmInvocation}`);
				check(npmInvocation.includes("KERNEL="), `installer unexpectedly bootstrapped kernel: ${npmInvocation}`);
			}
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function writeFakeCommands(binDir, npmLog) {
	if (process.platform === "win32") {
		writeFileSync(join(binDir, "node.cmd"), "@echo off\r\necho v22.8.0\r\n");
		writeFileSync(
			join(binDir, "npm.cmd"),
			`@echo off\r\n>"${npmLog}" echo %*\r\n>>"${npmLog}" echo TOOLS=%PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL%\r\n>>"${npmLog}" echo KERNEL=%PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL%\r\n`,
		);
		return;
	}

	const nodePath = join(binDir, "node");
	const npmPath = join(binDir, "npm");
	writeFileSync(nodePath, "#!/bin/sh\nprintf 'v22.8.0\\n'\n");
	writeFileSync(
		npmPath,
		`#!/bin/sh\nprintf '%s|TOOLS=%s|KERNEL=%s\\n' "$*" "$PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL" "$PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL" > "${npmLog}"\n`,
	);
	chmodSync(nodePath, 0o755);
	chmodSync(npmPath, 0o755);
}

function run(command, args, env, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdin.end(input ?? "");
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function check(condition, message) {
	if (!condition) failures.push(message);
}
