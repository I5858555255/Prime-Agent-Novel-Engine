#!/usr/bin/env node

const command = process.env.npm_lifecycle_event || "legacy release command";

console.error(`${command} is retired and cannot mutate or publish a Prime Agent release.`);
console.error("Use `npm run release:prepare -- patch|minor|0.x.y` to prepare version metadata.");
console.error("Use `npm run release:dry-run` to validate a built release candidate without publishing.");
console.error("Production releases and retries are owned by the protected Release Prime Agent workflow.");
process.exit(1);
