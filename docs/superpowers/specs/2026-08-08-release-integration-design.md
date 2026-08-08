# Integrated Release and Package Distribution

## Context

Four independently reviewed pull requests modify overlapping release surfaces:

- #1019 defines branded R2 SDK and library artifacts and the `prime-agent-ai` command identity.
- #1020 pins third-party workflow actions, applies exact job-permission allowlists, narrows release credentials, and protects beta promotion from stale runs.
- #1022 makes CI the release authority, retires local npm publication, defines immutable publication and retry behavior, and adds a protected pointer-only rollback.
- #1024 binds release verification, artifacts, manifests, and publication to one exact source SHA and gates publication on the full Node and Python suites.

Each pull request is green in isolation, but they cannot be merged independently without losing reviewed behavior. In particular, #1022 removes branch-selectable manual dispatch in favor of default-branch issue-comment authority, while #1024 reintroduces `workflow_dispatch` and tag-triggered publication. The release packer, release-context resolver, CI workflow, and package manifests also overlap.

Development and verification of this integration must not dispatch a release workflow or mutate npm, Git tags, R2, GitHub Releases, or channel pointers.

## Considered Approaches

### Separate integration pull request — selected

Create a new branch from current `main` and integrate the four reviewed contracts deliberately. Keep the original pull requests unchanged as review history until maintainers decide how to close them. This provides one merge target and one combined CI result without rewriting reviewed branches.

### Stack and rebase the original pull requests

Merge one pull request, rebase the next, and repeat. This preserves individual issue commits but makes correctness depend on merge order and requires repeated conflict resolution in security-critical workflow files. It also makes it easy to restore `workflow_dispatch` or drop an action pin accidentally.

### Rewrite #1022 as the umbrella pull request

Force all changes into the release-lifecycle pull request and supersede the other branches. This reduces pull-request count but obscures the reviewed issue boundaries and invalidates existing exact-head reviews. It is rejected.

## Scope

The integration owns:

- the combined behavior of issues #926, #927, #934, and #949;
- one automatic release trigger and one protected manual retry mechanism;
- exact-SHA full-suite verification;
- workflow action and permission security;
- branded R2 package artifacts and their clean-install contract;
- immutable release publication, beta freshness, idempotent retry, and pointer-only rollback;
- retirement of legacy local npm publishing;
- combined workflow, release, packaging, Python, and documentation verification.

It does not merge, close, or rewrite the four original pull requests. It does not change daemon protocol behavior. It does not publish branded packages to npm.

## Authority and Trigger Model

A successful `CI` workflow run from a same-repository push to the protected default branch is the only automatic publication trigger. The release workflow must verify all of the following before planning a release:

- the upstream workflow is the repository's canonical `CI` workflow;
- its conclusion is `success`;
- its event is `push`;
- its head repository is the current repository;
- its head branch is the current default branch;
- its head SHA is a complete 40-character commit SHA.

The release workflow does not expose `workflow_dispatch`. A tag push does not independently publish.

Every default-branch commit may produce a beta after exact-SHA verification. A new production release is planned only when the release-control version changes according to the release lifecycle policy.

Manual production retry uses the exact issue-comment command `/prime-agent release retry v0.X.Y`, loaded from protected default-branch workflow code. An ungated preflight job:

1. checks the actor's live repository permission through the GitHub API;
2. accepts only `admin` or `maintain`;
3. parses the command exactly;
4. resolves an existing immutable `vX.Y.Z` tag;
5. verifies that tag, package metadata, and default-branch ancestry agree;
6. emits the version and 40-character tag SHA as controlled outputs.

Only a successful preflight can schedule the downstream verification and mutation jobs. Unauthorized or malformed comments cannot acquire release concurrency, enter a protected environment, obtain write permissions, or receive credentials.

Manual rollback remains a separate exact issue-comment workflow. It requires two lines whose versions match: `/prime-agent release rollback v0.X.Y` followed by `ROLLBACK v0.X.Y`. Its authorization preflight follows the same isolation rules. Rollback may update only the stable channel pointers after verifying the existing immutable release.

## Exact-SHA Verification

All source checkouts, builds, package artifacts, workflow artifact names, manifests, checksums, GitHub Release targets, and R2 versioned paths bind to one resolved source SHA.

Default-branch publication consumes the successful upstream CI result only after verifying that result belongs to the resolved SHA. Retry invokes the reusable full CI workflow against the existing tag's SHA. Failed, cancelled, skipped, fork-originated, wrong-branch, wrong-workflow, or wrong-SHA verification prevents every publication job.

The reusable CI workflow includes:

- build and non-mutating repository checks;
- all Node workspace and coding-agent shards;
- kernel and process smoke coverage;
- the complete locked Python runtime suite;
- one aggregate success job on which publication depends.

Python dependencies use a committed uv lock generated by pinned uv 0.11.33 and the repository's seven-day cutoff. Tests are not skipped, stubbed, or reduced to avoid dependency failures.

## Protected Tooling and Tagged Source

Release tooling is checked out from the protected default-branch workflow commit. Release source is checked out separately at the resolved source SHA. This allows an old immutable tag to be retried even when that tag predates the current release scripts.

The current protected tooling validates and packages the exact source checkout. Source files and lockfiles come from the source checkout; release policy and publication implementation come from the protected tooling checkout. Every command receives the source root explicitly and may not fall back to the tooling checkout.

## Package Artifact Contract

Every stable and beta release contains four branded npm-format tarballs:

| Artifact | Public package/import |
| --- | --- |
| `prime-agent-<version>.tgz` | `prime-agent` |
| `prime-agent-ai-<version>.tgz` | `prime-agent-ai` |
| `prime-agent-core-<version>.tgz` | `prime-agent-core` |
| `prime-agent-tui-<version>.tgz` | `prime-agent-tui` |

The AI package exposes `prime-agent-ai` as its supported command and retains `pi-ai` as a compatibility alias. Documentation uses branded public imports and immutable R2 URLs. Inherited `@earendil-works/pi-*` names remain internal compatibility specifiers and are not advertised as supported registry installs.

The release manifest records the release version, channel, source SHA, artifact filenames, and SHA-256 values. `SHA256SUMS` and the manifest must describe the same complete set before publication starts.

## Credential and Permission Boundaries

Workflow permissions default to none or `contents: read`. Every workflow and job has an exact allowlisted permission map. Third-party actions use immutable full commit SHAs with version comments; both `.yml` and `.yaml` workflow files are covered by the security contract.

Credential boundaries are phase-specific:

- verification, build, pack, and artifact validation receive no publication credentials;
- GitHub tag, Release, and asset operations receive only `contents: write` through `GITHUB_TOKEN`;
- R2 immutable upload and verification receive only R2 credentials;
- R2 installer and pointer promotion receive only R2 credentials;
- rollback receives R2 credentials only after authorization and release verification.

No step receives both R2 credentials and GitHub write credentials. Secrets do not exist at workflow or broad job scope when a narrower mutation-step scope is possible.

## Production Transaction

The production transaction is:

1. Validate repository metadata, source SHA, version, tag, package lockstep, changelogs, internal dependency URLs, manifest, and checksums without publication credentials.
2. Verify or create the immutable Git tag and GitHub Release target using GitHub-only credentials.
3. Create each versioned R2 object if absent; if present, compare bytes/hashes and fail on mismatch. Never overwrite a different immutable object.
4. Create or verify every GitHub Release asset with the same compare-before-write rule.
5. Reverify the complete immutable R2 and GitHub asset sets.
6. Upload and verify the stable and beta installer scripts.
7. Read both current stable surfaces and refuse a version regression.
8. Write and verify `/stable`.
9. Write and verify `/latest.json` last as the stable commit marker.

A retry with identical inputs is a no-op or converges a partial transaction. A mismatch fails before mutable channel promotion. Only the protected rollback path may lower stable pointers.

## Beta Transaction

Beta publication uses unique immutable versioned paths and the same compare-before-write behavior. After immutable uploads, it rechecks that the source SHA is still the default-branch head immediately before each mutable phase:

1. GitHub beta tag/prerelease mirroring;
2. installer updates;
3. channel promotion.

A stale run may leave unique immutable artifacts but cannot update mutable beta state. Promotion writes and verifies `/beta`, then writes `/beta.json` last as the beta commit marker.

## Failure Handling

- A missing or malformed trigger, unauthorized actor, non-successful CI result, or SHA mismatch fails closed before credentials.
- Missing artifacts, unexpected artifact names, checksum drift, source-SHA drift, or remote immutable drift fail without channel mutation.
- Remote authorization, availability, or metadata errors are not interpreted as object absence.
- Existing incomplete immutable prefixes cause refusal unless every existing object matches the local release contract.
- Temporary files, local package projects, servers, and subprocesses are cleaned on success and failure.
- No retry moves an immutable tag, overwrites a different artifact, or regresses a channel pointer.

## Local Release Commands

`release:prepare` is the only supported local version mutation. It updates only release-controlled manifests, internal dependency ranges, lockfile entries, and changelog headings. It never commits, tags, pushes, publishes, or dispatches a workflow, and it restores the original tree after a mid-operation failure.

`release:dry-run` performs the same policy, packing, manifest, checksum, and clean-install validations without credentials or remote mutation. Legacy local `release:*`, `version:*`, `publish`, and `publish:dry` entry points hard-fail with migration guidance. The internal non-publishing packer remains available to CI.

## Verification

Combined deterministic tests cover:

- exact permission allowlists and full-SHA action pins for `.yml` and `.yaml`;
- successful same-repository/default-branch `workflow_run` handling;
- rejection of fork, wrong-workflow, wrong-branch, failed, cancelled, skipped, and wrong-SHA upstream runs;
- absence of `workflow_dispatch` and independent tag publication;
- authorized and unauthorized retry and rollback comments;
- retry invocation of reusable full CI at the tag SHA;
- aggregate Node and Python gate results;
- source-SHA-bound workflow artifact names, manifests, checksums, and publication inputs;
- old-tag source with current protected tooling;
- immutable object create, identical retry, partial-prefix refusal, and mismatch failure;
- stable and beta ordering, stale-beta rejection, retry convergence, and pointer-only rollback;
- clean-project installation, compilation, and runtime loading of all four branded artifacts;
- `prime-agent-ai` and `pi-ai` command behavior;
- no publication, tag, release, pointer, or workflow-dispatch side effects during tests.

Required validation before publication of the integration pull request:

- focused workflow-security tests;
- focused release lifecycle/publication/workflow tests;
- focused package-artifact contract tests;
- the complete locked Python runtime suite;
- full `npm run check`;
- YAML parsing and `git diff --check`;
- independent exact-head code and security review;
- fully green exact-head GitHub CI.

## Pull Request Handoff

The integration pull request references #1019, #1020, #1022, and #1024 and explains that it is the intended merge target. Its body uses closing keywords for issues #926, #927, #934, and #949 so GitHub closes them only if the integration pull request merges. The four original pull requests remain unchanged while the integration pull request is under review.

The integration pull request remains draft until independent review and exact-head CI are fully green. No maintainer is tagged before that point. It is never merged by the implementation agent.
