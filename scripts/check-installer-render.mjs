import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInstallerMinimumIsCurrent, renderInstaller, renderInstallerMinimum } from "./render-installer.mjs";

const installerTemplate = readFileSync("install.sh", "utf-8");
assertInstallerMinimumIsCurrent(installerTemplate);
const installerSource = renderInstallerMinimum(installerTemplate);
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const syncEnd = "\x1b[?2026l";
const failures = [];

if (mainCallIndex === -1) {
	console.error('Installer render check failed: could not find final main "$@" call.');
	process.exit(1);
}

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_test_cols=80
prime_agent_test_rows=24

prime_agent_read_terminal_size() {
	prime_agent_screen_cols="$prime_agent_test_cols"
	prime_agent_screen_rows="$prime_agent_test_rows"
}

print_render_meta() {
	label="$1"
	if prime_agent_show_logo; then
		visible=1
	else
		visible=0
	fi
	content_height=$(prime_agent_content_height)
	printf '__META__ %s cols=%s rows=%s layout_show_logo=%s lab_width=%s render_lab_width=%s compact=%s visible=%s content_height=%s\\n' \\
		"$label" "$prime_agent_screen_cols" "$prime_agent_screen_rows" "$prime_agent_screen_layout_show_logo" \\
		"$prime_agent_screen_layout_lab_width" "$prime_agent_screen_render_lab_width" "$prime_agent_screen_compact" "$visible" "$content_height"
}

render_case() {
	prime_agent_screen_title="Installing Prime Agent"
	prime_agent_screen_detail="Fetching the verified package."
	prime_agent_screen_question=
	prime_agent_screen_frame=1
	prime_agent_screen_cols="$1"
	prime_agent_screen_rows="$2"
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_init_screen_layout
	prime_agent_refresh_screen_layout_mode
	print_render_meta first
	printf '__RENDER_START__ first\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ first\\n'

	prime_agent_screen_frame=2
	prime_agent_screen_cols="$3"
	prime_agent_screen_rows="$4"
	prime_agent_refresh_screen_layout_mode
	print_render_meta second
	printf '__RENDER_START__ second\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ second\\n'
}

screen_case() {
	prime_agent_screen_enabled=1
	prime_agent_screen_drawn=0
	prime_agent_screen_last_cols=0
	prime_agent_screen_last_rows=0
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_screen_frame=0

	prime_agent_test_cols="$1"
	prime_agent_test_rows="$2"
	printf '__SCREEN_START__ first\\n' >&2
	prime_agent_screen "Installing Prime Agent" "Installing Prime Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ first\\n' >&2

	prime_agent_test_cols="$3"
	prime_agent_test_rows="$4"
	printf '__SCREEN_START__ second\\n' >&2
	prime_agent_screen "Installing Prime Agent" "Installing Prime Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ second\\n' >&2
}

progress_case() {
	progress_details="Preparing global install.
Linking command binaries.
Finalizing npm install."
	for progress_frame in 1 24 25 48 49 200; do
		prime_agent_animation_frame="$progress_frame"
		printf '__PROGRESS__ %s\t%s\t%s\\n' "$progress_frame" "$(prime_agent_animation_status "Installing Prime Agent" "$progress_details" static)" "$(prime_agent_animation_detail "$progress_details")"
	done
}

node_version_case() {
	version="$1"
	if node_version_string_is_new_enough "$version"; then
		supported=1
	else
		supported=0
	fi
	printf '__NODE_VERSION__ %s\t%s\n' "$version" "$supported"
}

package_manager_candidate_case() {
	manager="$1"
	PRIME_AGENT_TEST_NODE_VERSION="$2"
	export PRIME_AGENT_TEST_NODE_VERSION
	case "$manager" in
		apt) candidate_check=apt_node_candidate_is_new_enough ;;
		apk) candidate_check=apk_node_candidate_is_new_enough ;;
	esac
	if "$candidate_check"; then
		supported=1
	else
		supported=0
	fi
	printf '__NODE_CANDIDATE__ %s\t%s\t%s\n' "$manager" "$PRIME_AGENT_TEST_NODE_VERSION" "$supported"
}

render_case "$@"
screen_case "$@"
progress_case
node_version_case 20.6.0
node_version_case 22.7.0
node_version_case 22.8.0
node_version_case 23.0.0
node_version_case 22.8.0-rc.1
node_version_case 22.8.0-experimental
node_version_case 22.8.0-0.experimental
node_version_case 23.0.0-experimental
node_version_case 22.8.0+dfsg-1ubuntu1
node_version_case 22.8.0-1nodesource1
node_version_case 22.8.0-r0
node_version_case 22.8
node_version_case 22.8.0.1
node_version_case 22.8.0.
node_version_case 22.8.0+
node_version_case 22.8.0-r0junk

for candidate_version in \
	20.6.0 \
	22.7.0 \
	22.8.0 \
	23.0.0 \
	22.8.0-experimental \
	22.8.0+dfsg-1ubuntu1 \
	22.8.0-1nodesource1 \
	22.8.0-r0 \
	22.8 \
	22.8.0.1 \
	22.8.0. \
	22.8.0+ \
	22.8.0-r0junk; do
	package_manager_candidate_case apt "$candidate_version"
	package_manager_candidate_case apk "$candidate_version"
done
`;

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-render-"));
const harnessPath = join(tempDir, "harness.sh");
const commandStubDir = join(tempDir, "commands");

try {
	mkdirSync(commandStubDir);
	writeFileSync(harnessPath, harnessSource, "utf-8");
	writeCommandStub(
		join(commandStubDir, "apt-cache"),
		'printf "  Candidate: %s\\n" "$PRIME_AGENT_TEST_NODE_VERSION"',
	);
	writeCommandStub(join(commandStubDir, "apk"), 'printf "nodejs-%s\\n" "$PRIME_AGENT_TEST_NODE_VERSION"');
	assertInstallerRendering(tempDir);

	const stableVisible = runCase("stable visible logo", 100, 30, 90, 30);
	check(stableVisible.meta.first.visible === "1", "expected the initial large render to show the logo");
	check(stableVisible.meta.second.visible === "1", "expected a safe resize to keep showing the logo");
	check(
		stableVisible.meta.first.lab_width === stableVisible.meta.second.lab_width,
		"expected logo lab width to stay stable across a safe resize",
	);
	assertInstallerProgress(stableVisible.progress);
	assertNodeVersions(stableVisible.nodeVersions);
	assertPackageManagerCandidates(stableVisible.candidateVersions);

	const stableExpand = runCase("stable expanded logo", 60, 24, 120, 32);
	check(stableExpand.meta.first.visible === "1", "expected the initial medium render to show the logo");
	check(stableExpand.meta.second.visible === "1", "expected terminal growth to keep showing the logo");
	check(
		stableExpand.meta.first.lab_width === stableExpand.meta.second.lab_width,
		"expected logo lab width not to grow after terminal expansion",
	);

	const noLogoStart = runCase("small initial terminal", 41, 24, 100, 30);
	check(noLogoStart.meta.first.layout_show_logo === "0", "expected a too-narrow initial terminal to freeze text-only layout");
	check(noLogoStart.meta.second.visible === "0", "expected terminal growth not to enable a logo after text-only layout was frozen");

	const narrowLogo = runCase("narrow logo on width shrink", 100, 30, 60, 24);
	check(narrowLogo.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(narrowLogo.meta.second.compact === "0", "expected shrink below frozen lab width to keep rendering the logo");
	check(narrowLogo.meta.second.visible === "1", "expected narrow width mode to keep showing the logo");
	check(
		Number(narrowLogo.meta.second.render_lab_width) <= 59,
		"expected narrow width mode to keep the rendered lab width inside the resized terminal",
	);

	const compactWidth = runCase("compact on severe width shrink", 100, 30, 32, 24);
	check(compactWidth.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(compactWidth.meta.second.compact === "1", "expected shrink below logo width to use compact mode");
	check(compactWidth.meta.second.visible === "0", "expected severe compact width mode to hide the logo");

	const compactRows = runCase("compact on row shrink", 100, 30, 100, 10);
	check(compactRows.meta.first.visible === "1", "expected the initial tall render to show the logo");
	check(compactRows.meta.second.compact === "1", "expected shrink below frozen splash height to use compact mode");
	check(compactRows.meta.second.visible === "0", "expected compact row mode to hide the logo");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer render check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer render check passed.");

function writeCommandStub(path, command) {
	writeFileSync(path, `#!/bin/sh\n${command}\n`, "utf8");
	chmodSync(path, 0o755);
}

function assertInstallerRendering(outputDir) {
	const rendered = renderInstaller(installerTemplate, {
		baseUrl: " https://downloads.example.test/// ",
		channel: "stable",
	});
	check(rendered.includes("https://downloads.example.test"), "expected direct rendering to normalize the base URL");
	check(rendered.includes('prime_agent_default_release_channel="stable"'), "expected direct rendering to set the channel");
	check(!/__PRIME_AGENT_[A-Z0-9_]+__/.test(rendered), "expected direct rendering to resolve all placeholders");

	assertRenderFails(
		"missing base URL placeholder",
		installerTemplate.replace("__PRIME_AGENT_DOWNLOAD_BASE_URL__", ""),
		{ baseUrl: "https://downloads.example.test", channel: "stable" },
	);
	assertRenderFails(
		"duplicate base URL placeholder",
		`${installerTemplate}\n__PRIME_AGENT_DOWNLOAD_BASE_URL__\n`,
		{ baseUrl: "https://downloads.example.test", channel: "stable" },
	);
	assertRenderFails(
		"renamed base URL placeholder",
		installerTemplate.replace("__PRIME_AGENT_DOWNLOAD_BASE_URL__", "__PRIME_AGENT_DOWNLOAD_URL__"),
		{ baseUrl: "https://downloads.example.test", channel: "stable" },
	);
	assertRenderFails(
		"missing release channel placeholder",
		installerTemplate.replace("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", ""),
		{ baseUrl: "https://downloads.example.test", channel: "stable" },
	);
	assertRenderFails(
		"duplicate release channel placeholder",
		`${installerTemplate}\n__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__\n`,
		{ baseUrl: "https://downloads.example.test", channel: "stable" },
	);
	assertRenderFails(
		"renamed release channel placeholder",
		installerTemplate.replace(
			"__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__",
			"__PRIME_AGENT_RELEASE_CHANNEL__",
		),
		{ baseUrl: "https://downloads.example.test", channel: "stable" },
	);
	assertRenderFails(
		"unresolved installer placeholder",
		`${installerTemplate}\n__PRIME_AGENT_UNKNOWN__\n`,
		{ baseUrl: "https://downloads.example.test", channel: "stable" },
	);
	assertRenderFails("root-only base URL", installerTemplate, { baseUrl: " /// ", channel: "stable" });

	const cliOutput = join(outputDir, "install.rendered.sh");
	const cliResult = spawnSync(
		process.execPath,
		[
			"scripts/render-installer.mjs",
			"--base-url",
			"https://downloads.example.test///",
			"--channel",
			"beta",
			"--output",
			cliOutput,
		],
		{ encoding: "utf8" },
	);
	check(cliResult.status === 0, `expected installer renderer CLI to succeed: ${cliResult.stderr}`);
	if (cliResult.status === 0) {
		const cliRendered = readFileSync(cliOutput, "utf8");
		check(cliRendered.includes("https://downloads.example.test"), "expected CLI rendering to set the base URL");
		check(cliRendered.includes('prime_agent_default_release_channel="beta"'), "expected CLI rendering to set beta");
		check(!/__PRIME_AGENT_[A-Z0-9_]+__/.test(cliRendered), "expected CLI rendering to resolve all placeholders");
		const syntax = spawnSync("dash", ["-n", cliOutput], { encoding: "utf8" });
		check(syntax.status === 0, `expected CLI-rendered installer to pass dash syntax validation: ${syntax.stderr}`);
	}
}

function assertRenderFails(name, source, options) {
	try {
		renderInstaller(source, options);
		failures.push(`${name}: expected rendering to fail`);
	} catch {
		// Expected.
	}
}

function runCase(name, initialCols, initialRows, resizedCols, resizedRows) {
	const result = spawnSync("dash", [harnessPath, String(initialCols), String(initialRows), String(resizedCols), String(resizedRows)], {
		detached: true,
		encoding: "utf-8",
		env: {
			...process.env,
			PATH: `${commandStubDir}:${process.env.PATH ?? ""}`,
		},
	});
	if (result.status !== 0) {
		failures.push(`${name}: harness exited with ${result.status ?? "unknown"}\n${result.stderr}${result.stdout}`);
		return emptyParsedCase();
	}

	const parsed = parseRenderOutput(result.stdout);
	parsed.screens = parseScreenOutput(result.stderr);
	assertLineWidths(name, "first", parsed, initialCols, initialRows);
	assertLineWidths(name, "second", parsed, resizedCols, resizedRows);
	assertScreenFrame(name, "first", parsed, initialCols, initialRows);
	assertScreenFrame(name, "second", parsed, resizedCols, resizedRows);
	return parsed;
}

function parseRenderOutput(output) {
	const parsed = emptyParsedCase();
	let activeRender = null;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("__META__ ")) {
			const [, label, ...fields] = line.split(" ");
			parsed.meta[label] = Object.fromEntries(fields.map((field) => field.split("=")));
			continue;
		}
		if (line.startsWith("__RENDER_START__ ")) {
			activeRender = line.slice("__RENDER_START__ ".length);
			parsed.renders[activeRender] = [];
			continue;
		}
		if (line.startsWith("__RENDER_END__ ")) {
			activeRender = null;
			continue;
		}
		if (line.startsWith("__PROGRESS__ ")) {
			const [frame, status, detail] = line.slice("__PROGRESS__ ".length).split("\t");
			parsed.progress.push({ frame: Number(frame), status, detail });
			continue;
		}
		if (line.startsWith("__NODE_VERSION__ ")) {
			const [version, supported] = line.slice("__NODE_VERSION__ ".length).split("\t");
			parsed.nodeVersions[version] = supported === "1";
			continue;
		}
		if (line.startsWith("__NODE_CANDIDATE__ ")) {
			const [manager, version, supported] = line.slice("__NODE_CANDIDATE__ ".length).split("\t");
			parsed.candidateVersions[`${manager}:${version}`] = supported === "1";
			continue;
		}
		if (activeRender) {
			parsed.renders[activeRender].push(line.replace(ansiPattern, ""));
		}
	}

	return parsed;
}

function assertNodeVersions(versions) {
	const expected = {
		"20.6.0": false,
		"22.7.0": false,
		"22.8.0": true,
		"23.0.0": true,
		"22.8.0-rc.1": false,
		"22.8.0-experimental": false,
		"22.8.0-0.experimental": false,
		"23.0.0-experimental": false,
		"22.8.0+dfsg-1ubuntu1": true,
		"22.8.0-1nodesource1": true,
		"22.8.0-r0": true,
		"22.8": false,
		"22.8.0.1": false,
		"22.8.0.": false,
		"22.8.0+": false,
		"22.8.0-r0junk": false,
	};
	for (const [version, supported] of Object.entries(expected)) {
		check(versions[version] === supported, `expected Node ${version} support to be ${supported}`);
	}
}

function assertPackageManagerCandidates(versions) {
	const expected = {
		"20.6.0": false,
		"22.7.0": false,
		"22.8.0": true,
		"23.0.0": true,
		"22.8.0-experimental": false,
		"22.8.0+dfsg-1ubuntu1": true,
		"22.8.0-1nodesource1": true,
		"22.8.0-r0": true,
		"22.8": false,
		"22.8.0.1": false,
		"22.8.0.": false,
		"22.8.0+": false,
		"22.8.0-r0junk": false,
	};
	for (const manager of ["apt", "apk"]) {
		for (const [version, supported] of Object.entries(expected)) {
			check(
				versions[`${manager}:${version}`] === supported,
				`expected ${manager} Node ${version} candidate support to be ${supported}`,
			);
		}
	}
}

function parseScreenOutput(output) {
	const screens = {};
	for (const label of ["first", "second"]) {
		const startToken = `__SCREEN_START__ ${label}\n`;
		const endToken = `__SCREEN_END__ ${label}\n`;
		const startIndex = output.indexOf(startToken);
		if (startIndex === -1) {
			failures.push(`missing ${label} screen start marker`);
			continue;
		}
		const contentStart = startIndex + startToken.length;
		const endIndex = output.indexOf(endToken, contentStart);
		if (endIndex === -1) {
			failures.push(`missing ${label} screen end marker`);
			continue;
		}
		screens[label] = output.slice(contentStart, endIndex);
	}
	return screens;
}

function assertInstallerProgress(progress) {
	check(progress.length === 6, `expected six progress samples, got ${progress.length}`);
	if (progress.length !== 6) return;

	const expectedDetails = [
		"Preparing global install.",
		"Preparing global install.",
		"Linking command binaries.",
		"Linking command binaries.",
		"Finalizing npm install.",
		"Finalizing npm install.",
	];
	for (const [index, expectedDetail] of expectedDetails.entries()) {
		check(
			progress[index].detail === expectedDetail,
			`expected progress sample ${index + 1} to show "${expectedDetail}", got "${progress[index].detail}"`,
		);
		check(
			progress[index].status === "Installing Prime Agent...",
			`expected progress sample ${index + 1} to use indeterminate status`,
		);
		check(!progress[index].status.includes("%"), `expected progress sample ${index + 1} not to include a percent`);
	}
}

function assertLineWidths(name, label, parsed, cols, rows) {
	const lines = parsed.renders[label] ?? [];
	check(lines.length === rows, `${name}: expected ${label} render to have ${rows} rows, got ${lines.length}`);

	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} render line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function assertScreenFrame(name, label, parsed, cols, rows) {
	const screen = parsed.screens[label] ?? "";
	check(screen.endsWith(syncEnd), `${name}: expected ${label} screen frame to end with synchronized update close`);
	check(!screen.endsWith(`\n${syncEnd}`), `${name}: expected ${label} screen frame not to emit a trailing row newline`);
	check(countNewlines(screen) === rows - 1, `${name}: expected ${label} screen frame to contain ${rows - 1} line breaks`);

	const lines = screen.replace(ansiPattern, "").split("\n");
	check(lines.length === rows, `${name}: expected ${label} screen frame to contain ${rows} rows, got ${lines.length}`);
	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} screen line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function countNewlines(text) {
	let count = 0;
	for (const char of text) {
		if (char === "\n") count++;
	}
	return count;
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function emptyParsedCase() {
	return {
		meta: {
			first: {},
			second: {},
		},
		renders: {
			first: [],
			second: [],
		},
		screens: {},
		progress: [],
		nodeVersions: {},
		candidateVersions: {},
	};
}
