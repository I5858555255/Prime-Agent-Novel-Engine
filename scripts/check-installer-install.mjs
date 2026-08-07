import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);

if (mainCallIndex === -1) {
	console.error('Installer check failed: could not find final main "$@" call.');
	process.exit(1);
}

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

case "\${1:-}" in
	minimum)
		printf '__MINIMUM__ %s\\n' "$prime_agent_min_node_version"
		for version in 20.6.0 22.7.99 22.8.0 23.0.0; do
			if node_version_string_is_new_enough "$version"; then
				status=supported
			else
				status=unsupported
			fi
			printf '__VERSION__ %s %s\\n' "$version" "$status"
		done
		;;
	preflight)
		run_preflight_checks
		;;
	user-prefix)
		prime_agent_path_supports_install() {
			case "$1" in
				"$PRIME_AGENT_TEST_NPM_PREFIX"|"$PRIME_AGENT_TEST_NPM_PREFIX/"*) return 1 ;;
				*) return 0 ;;
			esac
		}
		prime_agent_prompt_yes_no() {
			return 0
		}
		configure_npm_install_environment
		printf '__PREFIX__ %s\\n' "$prime_agent_npm_prefix"
		printf '__BIN__ %s\\n' "$prime_agent_install_bin"
		install_prime_agent_package /fixture/prime-agent.tgz
		configure_installed_command_path "$prime_agent_install_bin"
		;;
	blocked-fallback-package)
		prime_agent_path_supports_install() {
			case "$1" in
				"$PRIME_AGENT_TEST_NPM_PREFIX"|"$PRIME_AGENT_TEST_NPM_PREFIX/"*|"$HOME/.local/lib/node_modules/$prime_agent_package") return 1 ;;
				*) return 0 ;;
			esac
		}
		configure_npm_install_environment
		;;
	shell-profile)
		uname() {
			printf '%s\n' "$PRIME_AGENT_TEST_UNAME"
		}
		detect_shell_profile
		;;
	unsupported-shell-path)
		configure_installed_command_path "$HOME/.local/bin"
		;;
	writable-prefix)
		prime_agent_path_supports_install() {
			return 0
		}
		configure_npm_install_environment
		printf '__PREFIX__ %s\\n' "$prime_agent_npm_prefix"
		printf '__BIN__ %s\\n' "$prime_agent_install_bin"
		install_prime_agent_package /fixture/prime-agent.tgz
		;;
	*)
		printf 'unknown installer check case: %s\\n' "\${1:-}" >&2
		exit 2
		;;
esac
`;

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-check-"));
const harnessPath = join(tempDir, "harness.sh");
const fakeBin = join(tempDir, "fake-bin");
const fakeNpmPath = join(fakeBin, "npm");
const fakeNodePath = join(fakeBin, "node");
const npmLogPath = join(tempDir, "npm.log");
const profilePath = join(tempDir, "profile");
const homeDir = join(tempDir, "home dir's");
const systemPrefix = join(tempDir, "system-prefix");
const writablePrefix = join(tempDir, "writable-prefix");
const failures = [];

try {
	mkdirSync(fakeBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(systemPrefix, { recursive: true });
	mkdirSync(writablePrefix, { recursive: true });
	writeFileSync(harnessPath, harnessSource, "utf-8");
	writeFileSync(
		fakeNodePath,
		`#!/bin/sh
if [ "\${1:-}" = --version ]; then
	printf 'v%s\\n' "$PRIME_AGENT_TEST_NODE_VERSION"
	exit 0
fi
exit 99
`,
		"utf-8",
	);
	writeFileSync(
		fakeNpmPath,
		`#!/bin/sh
case "\${1:-}:\${2:-}" in
	prefix:--global)
		printf '%s\\n' "$PRIME_AGENT_TEST_NPM_PREFIX"
		;;
	root:--global)
		printf '%s/lib/node_modules\\n' "$PRIME_AGENT_TEST_NPM_PREFIX"
		;;
	install:-g)
		printf 'prefix=%s\\n' "\${NPM_CONFIG_PREFIX-}" >>"$PRIME_AGENT_TEST_NPM_LOG"
		printf 'args=' >>"$PRIME_AGENT_TEST_NPM_LOG"
		printf ' <%s>' "$@" >>"$PRIME_AGENT_TEST_NPM_LOG"
		printf '\\n' >>"$PRIME_AGENT_TEST_NPM_LOG"
		;;
	*)
		printf 'unexpected npm invocation: %s\\n' "$*" >&2
		exit 98
		;;
esac
`,
		"utf-8",
	);
	chmodSync(harnessPath, 0o755);
	chmodSync(fakeNodePath, 0o755);
	chmodSync(fakeNpmPath, 0o755);

	assertMinimumNodeVersion();
	assertPreflightNodeVersion();
	assertUserPrefixFallback();
	assertBlockedFallbackPackageRejected();
	assertBashProfileSelection();
	assertUnsupportedShellPathInstructions();
	assertWritablePrefixPreserved();
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer install check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer install check passed.");

function assertMinimumNodeVersion() {
	const result = runHarness("minimum", { PRIME_AGENT_TEST_NODE_VERSION: "22.8.0" });
	check(result.status === 0, `minimum version harness exited with ${result.status ?? "unknown"}: ${result.stderr}`);
	const packageJson = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf-8"));
	const expectedMinimum = packageJson.engines.node.replace(/^>=/, "");
	check(result.stdout.includes(`__MINIMUM__ ${expectedMinimum}\n`), "installer minimum does not match package engines.node");
	check(result.stdout.includes("__VERSION__ 20.6.0 unsupported\n"), "expected Node 20.6.0 to be rejected");
	check(result.stdout.includes("__VERSION__ 22.7.99 unsupported\n"), "expected Node 22.7.99 to be rejected");
	check(result.stdout.includes("__VERSION__ 22.8.0 supported\n"), "expected Node 22.8.0 to be accepted");
	check(result.stdout.includes("__VERSION__ 23.0.0 supported\n"), "expected Node 23.0.0 to be accepted");
}

function assertPreflightNodeVersion() {
	const rejected = runHarness("preflight", { PRIME_AGENT_TEST_NODE_VERSION: "20.6.0" });
	check(rejected.status === 1, `Node 20 preflight exited with ${rejected.status ?? "unknown"}`);
	check(rejected.stdout.includes("requires Node.js 22.8.0 or newer"), "Node 20 preflight did not explain the 22.8.0 minimum");

	const accepted = runHarness("preflight", { PRIME_AGENT_TEST_NODE_VERSION: "22.8.0" });
	check(accepted.status === 0, `Node 22.8 preflight exited with ${accepted.status ?? "unknown"}: ${accepted.stderr}`);
}

function assertUserPrefixFallback() {
	writeFileSync(npmLogPath, "", "utf-8");
	const expectedPrefix = join(homeDir, ".local");
	const expectedBin = join(expectedPrefix, "bin");
	writeFileSync(
		profilePath,
		`# export PATH='${expectedBin}':"$PATH"\nexport PATH="/usr/bin:${expectedBin}:$PATH"\n`,
		"utf-8",
	);
	const result = runHarness("user-prefix", {
		PRIME_AGENT_TEST_NODE_VERSION: "22.8.0",
		PRIME_AGENT_TEST_NPM_PREFIX: systemPrefix,
	});
	check(result.status === 0, `user-prefix harness exited with ${result.status ?? "unknown"}: ${result.stderr}`);
	check(result.stdout.includes(`__PREFIX__ ${expectedPrefix}\n`), "unwritable npm prefix did not select ~/.local");
	check(result.stdout.includes(`__BIN__ ${expectedBin}\n`), "unwritable npm prefix reported the wrong command directory");

	const npmLog = readFileSync(npmLogPath, "utf-8");
	check(npmLog.includes(`prefix=${expectedPrefix}\n`), "npm install did not receive the fallback NPM_CONFIG_PREFIX");
	check(npmLog.includes("<--prefix>"), "npm install did not force the fallback prefix with --prefix");
	check(npmLog.includes("<install> <-g>"), "npm install did not run as a global install");
	check(npmLog.includes("</fixture/prime-agent.tgz>"), "npm install did not receive the release tarball");

	const profile = readFileSync(profilePath, "utf-8");
	check(profile.includes("# Prime Agent command"), "profile update did not include the Prime Agent marker");
	const profileCheck = spawnSync("sh", ["-n", profilePath], { encoding: "utf-8" });
	check(profileCheck.status === 0, `profile update is not valid shell: ${profileCheck.stderr}`);
	const sourced = spawnSync("sh", ["-c", '. "$PRIME_AGENT_TEST_PROFILE"; printf "%s" "$PATH"'], {
		encoding: "utf-8",
		env: { PATH: "/usr/bin:/bin", PRIME_AGENT_TEST_PROFILE: profilePath },
	});
	check(sourced.status === 0, `profile update could not be sourced: ${sourced.stderr}`);
	check(sourced.stdout.startsWith(`${expectedBin}:`), "profile update did not prepend the fallback npm bin directory");
}

function assertBlockedFallbackPackageRejected() {
	const result = runHarness("blocked-fallback-package", {
		PRIME_AGENT_TEST_NODE_VERSION: "22.8.0",
		PRIME_AGENT_TEST_NPM_PREFIX: systemPrefix,
	});
	check(result.status === 1, `blocked fallback package harness exited with ${result.status ?? "unknown"}`);
	check(result.stderr.includes("fallback prefix"), "blocked fallback package did not report the unwritable fallback");
}

function assertBashProfileSelection() {
	const bashProfilePath = join(homeDir, ".bash_profile");
	const bashLoginPath = join(homeDir, ".bash_login");
	const bashrcPath = join(homeDir, ".bashrc");
	const posixProfilePath = join(homeDir, ".profile");
	const automaticProfile = {
		PRIME_AGENT_TEST_NODE_VERSION: "22.8.0",
		PRIME_AGENT_TEST_SHELL_PROFILE_AUTO: "1",
	};

	writeFileSync(bashLoginPath, "", "utf-8");
	writeFileSync(posixProfilePath, "", "utf-8");
	let result = runHarness("shell-profile", { ...automaticProfile, PRIME_AGENT_TEST_UNAME: "Darwin" });
	check(result.status === 0, `macOS Bash profile harness exited with ${result.status ?? "unknown"}: ${result.stderr}`);
	check(result.stdout === bashLoginPath, "macOS Bash did not select the first existing login profile");

	rmSync(bashLoginPath);
	result = runHarness("shell-profile", { ...automaticProfile, PRIME_AGENT_TEST_UNAME: "Darwin" });
	check(result.stdout === posixProfilePath, "macOS Bash did not preserve an existing .profile");

	rmSync(posixProfilePath);
	result = runHarness("shell-profile", { ...automaticProfile, PRIME_AGENT_TEST_UNAME: "Darwin" });
	check(result.stdout === bashProfilePath, "macOS Bash did not default to .bash_profile");

	writeFileSync(bashrcPath, "", "utf-8");
	writeFileSync(posixProfilePath, "", "utf-8");
	result = runHarness("shell-profile", { ...automaticProfile, PRIME_AGENT_TEST_UNAME: "Linux" });
	check(result.stdout === posixProfilePath, "Linux Bash did not select an existing login profile");

	writeFileSync(bashProfilePath, "", "utf-8");
	result = runHarness("shell-profile", { ...automaticProfile, PRIME_AGENT_TEST_UNAME: "Linux" });
	check(result.stdout === bashProfilePath, "Linux Bash did not honor Bash login-profile precedence");

	rmSync(bashProfilePath);
	rmSync(posixProfilePath);
	result = runHarness("shell-profile", { ...automaticProfile, PRIME_AGENT_TEST_UNAME: "Linux" });
	check(result.stdout === bashrcPath, "Linux Bash did not default to .bashrc when no login profile exists");
}

function assertUnsupportedShellPathInstructions() {
	const result = runHarness("unsupported-shell-path", {
		PRIME_AGENT_TEST_NODE_VERSION: "22.8.0",
		PRIME_AGENT_TEST_SHELL: "/usr/bin/fish",
		PRIME_AGENT_TEST_SHELL_PROFILE_AUTO: "1",
	});
	check(result.status === 0, `unsupported-shell harness exited with ${result.status ?? "unknown"}: ${result.stderr}`);
	check(result.stdout.includes(`Add ${join(homeDir, ".local/bin")} to PATH using your shell configuration.`), "unsupported shell did not receive shell-neutral PATH guidance");
	check(result.stdout.includes(`Run Prime Agent now with: ${join(homeDir, ".local/bin/prime-agent")}`), "unsupported shell did not receive an immediately runnable command");
	check(!result.stdout.includes("export PATH="), "unsupported shell received POSIX-only PATH syntax");
}

function assertWritablePrefixPreserved() {
	writeFileSync(npmLogPath, "", "utf-8");
	const result = runHarness("writable-prefix", {
		PRIME_AGENT_TEST_NODE_VERSION: "22.8.0",
		PRIME_AGENT_TEST_NPM_PREFIX: writablePrefix,
	});
	check(result.status === 0, `writable-prefix harness exited with ${result.status ?? "unknown"}: ${result.stderr}`);
	check(result.stdout.includes("__PREFIX__ \n"), "writable npm prefix unexpectedly selected an override");
	check(result.stdout.includes(`__BIN__ ${join(writablePrefix, "bin")}\n`), "writable npm prefix reported the wrong bin directory");
	const npmLog = readFileSync(npmLogPath, "utf-8");
	check(npmLog.includes("prefix=\n"), "writable npm prefix unexpectedly set NPM_CONFIG_PREFIX");
}

function runHarness(testCase, overrides) {
	const env = {
		...process.env,
		...overrides,
		HOME: homeDir,
		PATH: `${fakeBin}:${process.env.PATH}`,
		PRIME_AGENT_INSTALLER_PLAIN: "1",
		PRIME_AGENT_SHELL_PROFILE: profilePath,
		PRIME_AGENT_TEST_NPM_LOG: npmLogPath,
		SHELL: overrides.PRIME_AGENT_TEST_SHELL ?? "/bin/bash",
	};
	delete env.NPM_CONFIG_PREFIX;
	if (env.PRIME_AGENT_TEST_SHELL_PROFILE_AUTO === "1") delete env.PRIME_AGENT_SHELL_PROFILE;
	return spawnSync("sh", [harnessPath, testCase], { encoding: "utf-8", env });
}

function check(condition, message) {
	if (!condition) failures.push(message);
}
