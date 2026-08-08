#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyCiResults } from "./verify-ci-results.mjs";

const releaseTriggers = new Set(["main", "retry"]);

export function verifyReleaseGate({ build, fullCi, releaseContext, trigger }) {
	if (!releaseTriggers.has(trigger)) throw new Error(`Unsupported release trigger: ${trigger || "missing"}`);
	verifyCiResults({ build, "release-context": releaseContext });
	if (trigger === "main") {
		if (fullCi !== "skipped") {
			throw new Error(`Main release must reuse completed upstream CI, received full-ci=${fullCi}`);
		}
		return;
	}
	verifyCiResults({ "full-ci": fullCi });
}

function main() {
	const values = {};
	for (const argument of process.argv.slice(2)) {
		const separator = argument.indexOf("=");
		if (separator < 1) throw new Error(`Expected name=value, received ${argument}`);
		const name = argument.slice(0, separator);
		if (Object.hasOwn(values, name)) throw new Error(`Duplicate release gate value: ${name}`);
		values[name] = argument.slice(separator + 1);
	}
	verifyReleaseGate({
		build: values.build,
		fullCi: values["full-ci"],
		releaseContext: values["release-context"],
		trigger: values.trigger,
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
