#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const [baseUrlArgument, stablePath, betaPath] = process.argv.slice(2);
const baseUrl = baseUrlArgument?.replace(/\/+$/, "");
if (!baseUrl || !stablePath || !betaPath) {
	console.error("Usage: node scripts/render-release-installers.mjs <base-url> <stable-path> <beta-path>");
	process.exit(1);
}

const installer = readFileSync("install.sh", "utf8");
const renderInstaller = (channel) =>
	installer
		.replaceAll("__PRIME_AGENT_DOWNLOAD_BASE_URL__", baseUrl)
		.replaceAll("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", channel);

writeFileSync(stablePath, renderInstaller("stable"));
writeFileSync(betaPath, renderInstaller("beta"));
