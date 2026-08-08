# Releasing Prime Agent

The protected GitHub Actions workflows are the only release authority. Local commands may prepare and validate release files, but they never publish packages, create or move tags, push branches, upload artifacts, or promote a release channel.

Prime Agent's supported distribution is the branded R2 tarball bundle installed by `install.sh`. The inherited npm workspace names are source-level implementation details. Direct SDK and library distribution is tracked separately in issue #949.

## Release Contract

A stable version consists of:

- immutable objects under `releases/vX.Y.Z/`;
- an immutable `vX.Y.Z` Git tag and matching GitHub Release assets;
- the `/stable` text pointer used by existing installers;
- `/latest.json`, the stable commit marker used by update checks.

Beta uses the same versioned R2 object rules, plus the mutable `/beta`, `/beta.json`, `beta` tag, and beta prerelease compatibility surfaces. Installers continue to read the text pointers, while running clients read the JSON manifests. Do not remove or change either shape without a separate compatibility plan.

The root release-control version and these four packaged workspaces are lockstep:

- `packages/agent`
- `packages/ai`
- `packages/coding-agent`
- `packages/tui`

Private and example workspaces are not release packages and must remain untouched. Prime Agent supports patch and minor releases while the major version remains zero.

## Prepare a Release Pull Request

Start from a clean feature branch after reviewing every package's `[Unreleased]` section. Run one of:

```bash
npm run release:prepare -- patch
npm run release:prepare -- minor
npm run release:prepare -- 0.8.1
```

The command updates only the root release-control manifest, the four packaged manifests, internal dependency ranges, corresponding lockfile metadata, and those four changelogs. It restores every original file if any replacement fails, and it does not stage or commit the result.

Review the complete diff. Confirm that each changelog release section is accurate, private/example manifests did not change, and the lockfile contains only expected version and internal-range changes.

Build the candidate using the normal repository build process, then run the non-publishing validation:

```bash
npm run release:dry-run
npm run release:test
npm run check
```

`release:dry-run` packages into a temporary directory, validates tarball names and manifests, verifies every SHA-256 digest and internal R2 URL, and removes its output. It has no npm, GitHub Release, Git tag, Git push, or R2 publication path.

Open and review the release-preparation pull request. Merging the exact version-preparation commit to the protected default branch is the only way to introduce a new production candidate.

## CI Publication

For each default-branch push, the Release Prime Agent workflow builds a beta. It additionally publishes production only when the root version changed to a strictly newer validated version.

The production transaction is ordered as follows:

1. Resolve and validate the exact version, commit, lockfile, package manifests, changelogs, and existing tag state using the protected workflow commit's release tooling.
2. Build, check, run the release lifecycle tests, pack once, and validate the workflow artifacts without publication credentials.
3. Create or verify the immutable version tag and GitHub Release target.
4. Create missing versioned R2 objects using conditional writes. Existing objects must be byte-identical.
5. Upload missing GitHub Release assets. Existing assets must be byte-identical and are never clobbered.
6. Verify all versioned R2 and GitHub Release objects.
7. Upload and verify the stable and beta installer scripts.
8. Write and verify `/stable`.
9. Write and verify `/latest.json` last.

The workflow serializes publication and refuses to move either stable surface backward: the effective monotonic floor is the higher version named by `/stable` or `/latest.json`. Only the protected rollback workflow may lower both surfaces. Issue #927 separately owns the full exact-commit Node and Python suite gate; do not treat the focused release tests as that broader gate.

## Retry

After the immutable `vX.Y.Z` tag exists, a maintainer with repository `admin` or `maintain` permission can post this exact issue comment:

```text
/prime-agent release retry vX.Y.Z
```

The `issue_comment` event always loads workflow code from the protected default branch; branch-selectable release dispatches are not supported. The workflow derives both the version and commit from the tag, verifies that it belongs to the default branch, and rebuilds the exact tagged source. Release policy and publication scripts come from the protected workflow commit in a separate checkout, so tags created before this lifecycle was introduced remain retryable. A free-form version paired with current `main` is not supported.

If the original production run failed before creating the version tag, rerun that exact failed workflow run instead. Do not use a later default-branch run or create the tag locally. Once the immutable tag exists, use the issue-comment retry command for subsequent recovery attempts.

Retries are idempotent:

- a failure before tag creation has no release state;
- an empty release or partially uploaded immutable set can be completed by retry;
- identical existing R2 and GitHub Release objects are reused;
- any existing object with different bytes hard-fails;
- if `/stable` advanced but `/latest.json` did not, retry completes the JSON commit marker.

Never delete or replace an immutable version tag or artifact to make a retry pass. Investigate the mismatch and prepare a new version.

## Rollback

Prefer a forward fix. If stable must be restored immediately, a maintainer with repository `admin` or `maintain` permission can post this exact two-line issue comment:

```text
/prime-agent release rollback vX.Y.Z
ROLLBACK vX.Y.Z
```

The default-branch workflow and an API-derived maintainer permission are the repository-enforced authorization boundary. Authorization and exact command parsing complete in an ungated preflight job before the workflow can acquire the shared release lock or enter the `production` environment, so an unauthorized comment cannot block publication. The mutation job targets the `production` environment, so configured environment reviewers provide an additional gate but are not assumed to exist. It verifies the immutable tag, GitHub Release assets, manifest, checksums, and every referenced R2 tarball before writing `/stable` and then `/latest.json`. It does not create or move tags, rewrite immutable objects, or change GitHub Releases.

Rollback changes what fresh installations and future update checks select. It does not force already-installed newer clients to downgrade.

## Retired Commands

The inherited `release:*`, `version:*`, root `publish`, root `publish:dry`, and `scripts/sync-versions.js` paths intentionally hard-fail. They previously operated on unrelated workspaces, npm publication, local commits and tags, and direct pushes to `main`. Do not restore or bypass them.

`release:pack` remains internal non-publishing packaging machinery used by the dry run and CI.
