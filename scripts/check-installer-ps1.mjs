import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.ps1 is published the same way install.sh is: the release workflow
// substitutes the two placeholders and uploads the result. This check keeps the
// Windows installer honest about that contract, and — on Windows — proves the
// script still parses.
const installerSource = readFileSync("install.ps1", "utf-8");
const failures = [];

const placeholders = ["__PRIME_AGENT_DOWNLOAD_BASE_URL__", "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"];
for (const placeholder of placeholders) {
	if (!installerSource.includes(placeholder)) {
		failures.push(`missing release placeholder ${placeholder}`);
	}
}

// The "unconfigured" sentinels must stay split across a concatenation so that
// substituting the placeholders cannot also rewrite the value they compare
// against — the same trick install.sh uses.
for (const [name, expression] of [
	["download base url", "'__PRIME_AGENT_DOWNLOAD_BASE' + '_URL__'"],
	["default release channel", "'__PRIME_AGENT_DEFAULT_RELEASE_' + 'CHANNEL__'"],
]) {
	if (!installerSource.includes(expression)) {
		failures.push(`unconfigured ${name} sentinel must stay split as: ${expression}`);
	}
}

const rendered = installerSource
	.replaceAll("__PRIME_AGENT_DOWNLOAD_BASE_URL__", "https://example.test/prime-agent")
	.replaceAll("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", "stable");

const leftover = rendered.match(/__PRIME_AGENT_[A-Z_]+__/g);
if (leftover) {
	failures.push(`rendered installer still contains placeholders: ${[...new Set(leftover)].join(", ")}`);
}
if (!rendered.includes("'__PRIME_AGENT_DOWNLOAD_BASE' + '_URL__'")) {
	failures.push("rendering rewrote the unconfigured download base url sentinel");
}

if (process.platform === "win32") {
	const workDir = mkdtempSync(join(tmpdir(), "prime-agent-install-ps1-"));
	try {
		const renderedPath = join(workDir, "install.ps1");
		writeFileSync(renderedPath, rendered, "utf-8");
		const parse = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${renderedPath.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.ToString() }; exit 1 }`,
			],
			{ encoding: "utf-8", windowsHide: true },
		);
		if (parse.status !== 0) {
			failures.push(`PowerShell could not parse the rendered installer:\n${parse.stdout ?? ""}${parse.stderr ?? ""}`);
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
}

if (failures.length > 0) {
	console.error("Windows installer check failed:");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log("Windows installer check passed.");
