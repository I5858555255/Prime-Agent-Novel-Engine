# CI-Authoritative Release Lifecycle

## Context

Issue [#934](https://github.com/PrimeIntellect-ai/prime-agent/issues/934) retires an inherited local npm release path that can version every workspace, publish packages, create commits and tags, and push `main`. Prime Agent's supported distribution is instead a set of branded, versioned tarballs published by GitHub Actions to R2 and mirrored in a GitHub Release.

The implementation must not dispatch a release workflow or mutate npm, Git tags, R2, or GitHub Releases while it is developed or tested.

## Scope

This change owns:

- one CI-authoritative production and beta release lifecycle;
- local version preparation and non-publishing validation;
- retirement of the local npm publish, commit, tag, and push path;
- immutable version, commit, tag, and artifact rules;
- idempotent production retry;
- ordered stable-channel promotion and a protected pointer-only rollback;
- release tests and maintainer documentation.

Related work remains separate:

- #926 owns action pinning, job permissions, and credential scope;
- #927 owns the full exact-commit Node and Python test gate;
- #949 owns supported public SDK and library package identities.

There is no daemon protocol change.

## Authority and Triggers

A merged release-preparation commit on the protected default branch is the only source of a new production version. CI derives the version and commit from repository state; it does not accept a free-form version paired with the current branch head.

Every default-branch commit may produce a beta. A production release is additionally planned only when the root release-control version changes to a valid higher version. Tag pushes do not independently publish.

A manual production retry is an exact issue-comment command from an actor whose repository permission resolves to `admin` or `maintain`. GitHub loads `issue_comment` workflow code from the default branch, so the privileged path has no branch-selectable dispatch. CI accepts only an existing immutable `vX.Y.Z` tag, derives both the version and commit from that tag, verifies that the tag is on the default branch and that repository metadata at the tagged commit agrees, and then reruns the same publication transaction. The protected workflow commit supplies release tooling from a separate checkout while the tagged checkout supplies source and lockfiles, preserving retries for tags created before this lifecycle existed.

## Local Commands

`release:prepare` is the only supported version mutation command. It updates the root release-control manifest, the four R2-packaged workspaces, their internal dependency ranges, the matching lockfile entries, and their changelog headings. All replacement files are staged before the first rename, and a failed replacement restores every original file. It never stages, commits, tags, pushes, publishes, or invokes a release workflow. Private and example workspaces remain untouched.

`release:dry-run` performs repository and artifact validation without publication credentials or remote mutation. It writes packaging output only to a temporary release directory and removes that directory on success or failure. The dry run verifies:

- patch/minor-only plain semantic versions;
- lockstep root and R2-packaged workspace versions;
- internal dependency and lockfile consistency;
- a matching released changelog section for production candidates;
- branded tarball names and manifest paths;
- SHA-256 sums and manifest hashes;
- tarball package manifests and internal R2 dependency URLs.

The existing `release:*`, `version:*`, `publish`, and `publish:dry` entry points become non-mutating tombstones with migration instructions. `release:pack` remains internal non-publishing packaging machinery.

## Repository Validation

The same pure policy code is used by local validation, tests, and workflow context resolution. Production validation requires:

- the root and the four packaged workspace versions to match;
- the major version to remain zero;
- the candidate to be strictly newer than the previous production version;
- all packaged-workspace dependency ranges and lockfile metadata to match;
- each packaged workspace changelog to contain the candidate release heading;
- a `vX.Y.Z` tag to be absent or point to the exact candidate commit;
- retry tags to exist, point to the validated commit, and be ancestors of the default branch.

Private and example workspace versions are explicitly outside release lockstep.

## Publication Transaction

CI builds each artifact once. The uploaded workflow artifact is the only input to publication and retry within that run.

The production transaction is:

1. Validate repository, version, commit, and tag invariants.
2. Verify or create the immutable `vX.Y.Z` tag and GitHub Release target.
3. For each versioned R2 object and GitHub Release asset, create it if absent; if present, compare its hash and fail on any mismatch. Never overwrite a different object.
4. Verify all versioned objects and GitHub Release assets.
5. Upload and verify the stable and beta installer scripts.
6. Confirm the candidate does not regress either existing stable surface, then write and verify the legacy `/stable` text pointer.
7. Write and verify `/latest.json` last. This JSON manifest is the stable commit marker.

If a failure occurs before step 6, stable clients do not observe the candidate. If step 6 succeeds but step 7 fails, fresh installs may resolve the new complete release while update checks still see the previous release; rerunning the same tagged release converges safely. Repeating any completed step with identical content is a no-op.

Beta publication keeps its stale-default-branch guard. After immutable uploads it rechecks default-branch freshness immediately before the GitHub mirror, installer updates, and channel-pointer promotion. It applies the same compare-before-write rule to versioned objects, updates `/beta` before `/beta.json`, and treats `/beta.json` as the beta commit marker. The mutable `beta` Git tag and prerelease remain beta-only compatibility surfaces.

## Rollback

Rollback is a separate exact two-line issue-comment command authorized by protected default-branch workflow code and an API-derived `admin` or `maintain` permission. The workflow also names the `production` environment as an optional additional gate. It requires an existing stable `vX.Y.Z` tag and matching confirmation text. Normal publication treats the higher version from `/stable` and `/latest.json` as the monotonic floor; only this rollback path may lower both.

The rollback workflow verifies the tag target, GitHub Release, saved release manifest, checksums, and every referenced R2 artifact before changing channel state. It changes only `/stable` and `/latest.json`, in that order. It never creates or moves an immutable version tag and never deletes or overwrites a versioned object.

Rollback changes what fresh installations and later update checks select. It does not force already-installed newer clients to downgrade. A forward fix is preferred when possible.

## Compatibility

The following public release contracts remain unchanged:

- `releases/vX.Y.Z/*` object paths and branded tarball names;
- `/stable` and `/beta` text pointers used by installers;
- `/latest.json` and `/beta.json` response shapes used by update checks;
- checksum verification and installer URLs.

Existing npm package identities are neither unpublished nor redefined. Direct SDK/library distribution is deferred to #949.

## Verification

Deterministic tests cover:

- default-branch beta-only and version-bump production plans;
- maintainer-authorized default-branch retry from an existing tag and rejection of free-form or conflicting targets;
- public-package version, dependency, lockfile, changelog, and tag drift;
- rejection of major, equal, and lower versions;
- private/example workspace preservation during preparation;
- immutable object create, identical retry, and mismatch failure decisions;
- stable and beta pointer ordering;
- rollback confirmation, target verification, and pointer-only behavior;
- dry-run cleanup and absence of publish, commit, tag, push, GitHub Release, and R2 commands;
- packed manifest, checksum, and internal URL correctness.

The release workflow runs the focused release tests and dry run after the existing build and check. Issue #927 will separately add the repository's full test-suite publication gate.
