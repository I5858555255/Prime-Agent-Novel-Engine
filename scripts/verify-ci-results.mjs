#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const validResults = new Set(["success", "failure", "cancelled", "skipped"]);

export function verifyCiResults(results) {
	if (Object.keys(results).length === 0) throw new Error("At least one CI result is required");
	const unsuccessful = [];
	for (const [name, result] of Object.entries(results)) {
		if (!validResults.has(result)) throw new Error(`Invalid CI result for ${name}: ${result}`);
		if (result !== "success") unsuccessful.push(`${name}=${result}`);
	}
	if (unsuccessful.length > 0) throw new Error(`Required CI jobs did not succeed: ${unsuccessful.join(", ")}`);
}

function main() {
	const results = {};
	for (const argument of process.argv.slice(2)) {
		const separator = argument.indexOf("=");
		if (separator < 1) throw new Error(`Expected name=result, received ${argument}`);
		const name = argument.slice(0, separator);
		if (Object.hasOwn(results, name)) throw new Error(`Duplicate CI result: ${name}`);
		results[name] = argument.slice(separator + 1);
	}
	verifyCiResults(results);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
