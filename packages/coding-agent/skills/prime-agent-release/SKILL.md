---
name: prime-agent-release
description: Prepare or verify a Prime Agent release. Use in the PrimeIntellect-ai/prime-agent repository when asked to bump versions, create a release PR, finalize release changelogs, verify the GitHub release workflow, or confirm the R2 stable artifacts.
---

# Prime Agent Release

Follow the repository's current `AGENTS.md` first. Release work is deliberately split into a
small version-only PR and the automated publish workflow that runs after a human merges it.

## Guardrails

- Work in a dedicated clean worktree on a `release/<version>` branch.
- Never mix feature fixes into a release PR.
- Never merge a release PR. Prepare it and stop for human review.
- Do not commit, tag, push, publish, or run `npm run release:*` unless the user explicitly asks.
- Do not run `npm run build`, `npm test`, or broad tests unless the user explicitly overrides the
  repository rules.
- Use patch releases for fixes and non-breaking features, and minor releases for breaking changes.
  Prime Agent does not use major releases.
- Keep versions in lockstep across the root package and the four published packages:
  `packages/agent`, `packages/ai`, `packages/coding-agent`, and `packages/tui`.
- Do not bump example or private workspace versions.

## Release PR

The release PR contains only release metadata:

- root and published package versions;
- internal package dependency ranges;
- `package-lock.json`;
- finalized package changelog sections.

Examples:

- [PR #527: prepare v0.3.3 release](https://github.com/PrimeIntellect-ai/prime-agent/pull/527)
- [PR #477: release v0.3.2](https://github.com/PrimeIntellect-ai/prime-agent/pull/477)

### Prepare

Inspect the checkout and choose a version greater than the current one:

```bash
git status --short --branch
git worktree list
node -p "require('./package.json').version"
```

Create or reuse a clean release worktree. Never prepare a release in a dirty checkout.

Read every affected package's complete `[Unreleased]` section. Preserve the flat bullet format
required by `AGENTS.md`, move those bullets under `## [X.Y.Z] - YYYY-MM-DD`, and leave a new empty
`## [Unreleased]` section above it.

### Bump versions

Do not use workspace-wide `npm version -ws` commands. Set only the root and published manifests:

```bash
node -e '
const fs = require("node:fs");
const version = process.argv[1];
const files = [
  "package.json",
  "packages/agent/package.json",
  "packages/ai/package.json",
  "packages/coding-agent/package.json",
  "packages/tui/package.json",
];
for (const file of files) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
}
' <x.y.z>
node scripts/sync-versions.js
npm pkg set dependencies.@earendil-works/pi-coding-agent='^<x.y.z>'
npm install --package-lock-only --ignore-scripts
```

### Verify

```bash
node scripts/sync-versions.js
git diff -- package.json package-lock.json packages/*/package.json packages/*/CHANGELOG.md
npm run check
```

Confirm that:

- all five release versions match;
- internal dependency ranges use the new version;
- no example/private workspace changed;
- every changelog has one correctly dated release heading;
- the diff contains no runtime code.

Stage only the explicit release files. Push the release branch, open the PR, and stop for human
review.

## Publish Verification

After the user says the release PR was merged, watch the `Release Prime Agent` workflow. It should:

1. build and check the repository;
2. pack `prime-agent-X.Y.Z.tgz` and the internal package tarballs;
3. create or update the GitHub Release;
4. upload tarballs, `SHA256SUMS`, `stable`, `latest.json`, and `install.sh` to R2.

The installer reads the R2 `stable` pointer and installs `prime-agent-<version>.tgz`. Do not call
the release live until the workflow is green, the GitHub Release exists, and the public R2
`stable` and `latest.json` both report the intended version.

If publishing fails, diagnose the workflow and prepare a separate fix PR. Do not force tags,
force-push, or merge fixes yourself.

## Slack Draft

After preparing or verifying a release, include a concise Slack-ready draft in the response. Lead
with the largest user-visible changes, group related implementation details, and mention major
reliability improvements. Keep the announcement out of repository files unless the user
explicitly asks to store it.
