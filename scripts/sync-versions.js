#!/usr/bin/env node

console.error("scripts/sync-versions.js is retired because it included private and example workspaces in release lockstep.");
console.error("Use `npm run release:prepare -- patch|minor|0.x.y` for the four R2-packaged workspaces.");
process.exit(1);
