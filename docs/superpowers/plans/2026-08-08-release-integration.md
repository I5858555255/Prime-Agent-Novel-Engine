# Integrated Release and Package Distribution — Implementation Plan

## Objective

Implement the approved design in `docs/superpowers/specs/2026-08-08-release-integration-design.md` on branch `agent/release-integration`. The result must combine the reviewed behavior from PRs #1019, #1020, #1022, and #1024 into one merge target without dispatching or mutating any release system.

## Source revisions

- Base: `a18809e00ea30638584d87b3afea7285a9d7296c`
- #1019: `85c63cc4da77cb1410aeaae32f71d853d74da784`
- #1020 implementation: `1133b855bb377203af0752ac77edcac53cbef932`
- #1022: `07e51ea852109274e8b69d04dfdcf214e09ee345`
- #1024: `259e267b703f35589d43cb261dd56cf2432b956d`
- Integration design: `c1447c48`

Stop and report if any source head changes before publication. Do not silently substitute a newer revision.

## Hard boundaries

- Never dispatch `.github/workflows/build-binaries.yml` or `.github/workflows/rollback-release.yml`.
- Never create, move, or delete Git tags.
- Never upload to R2, create/edit a GitHub Release, publish to npm, mark another PR ready, merge, or push `main`.
- Preserve the four original PRs unchanged.
- Do not add `workflow_dispatch` or tag-push publication.
- Do not weaken full-SHA action pins, exact permission allowlists, seven-day dependency policy, exact-SHA verification, or the complete Python suite.
- Do not modify `packages/ai/src/models.generated.ts`.
- Use exact-file staging only.

## Step 1 — Import non-conflicting package and documentation behavior

Bring the logical changes from #1019 into the integration branch:

- branded artifact package names and internal R2 dependency URLs;
- canonical artifact installation documentation;
- SDK/library documentation corrections;
- `prime-agent-ai` command alias and branded CLI text;
- package-documentation and CLI-branding tests;
- clean-project release-package contract script and CI hook;
- package and changelog updates.

Files are the #1019 file set reported by GitHub. Preserve the integration design document when applying its design commit.

Verification:

- Run `cd packages/ai && npx tsx ../../node_modules/vitest/dist/cli.js --run test/cli-branding.test.ts`.
- Run the exact coding-agent documentation test from package root.
- Run the clean-project release-package contract after the required build artifact exists; do not run `npm run build` directly because repository instructions forbid it. Use the already-reviewed script only during the final CI-equivalent validation path provided by the integrated workflow tests.

## Step 2 — Import the CI-authoritative release lifecycle

Bring the release policy, scripts, tests, documentation, and local command retirement from #1022:

- `release:prepare`, `release:dry-run`, and legacy-command tombstones;
- release lifecycle and publication libraries;
- protected-tooling/tagged-source separation;
- issue-comment retry and rollback parsers;
- immutable R2/GitHub decisions;
- stable/beta ordering and freshness checks;
- release documentation and focused tests.

Resolve package/changelog conflicts additively. Preserve all #1019 artifact names and documentation.

The release workflow authority after this step must be:

- automatic default-branch behavior only through a successful canonical `CI` `workflow_run`;
- production retry only through `/prime-agent release retry v0.X.Y`;
- rollback only through the exact two-line rollback command;
- no `workflow_dispatch`;
- no tag-push publication.

## Step 3 — Integrate exact-SHA verification

Bring the reusable CI, runtime lock, source-SHA manifest, artifact verification, gate helper, and regression tests from #1024.

Reconcile rather than copy its trigger model:

- retain #1022 issue-comment retry and rollback authority;
- replace #1024's manual/tag triggers with the protected issue-comment retry;
- for retry, invoke reusable CI at the preflight-resolved tag SHA;
- for automatic default-branch runs, bind to and verify the successful upstream CI head SHA;
- give every workflow artifact a source-SHA-qualified name;
- validate local and remote manifest/checksum/source-SHA consistency before mutation.

The complete Python runtime suite must use the committed uv lock, pinned uv 0.11.33, CPython 3.11.15, and the repository cutoff. Do not omit test groups or imports.

## Step 4 — Apply workflow security as the final invariant

Integrate #1020's workflow-security contract after the final workflow shapes exist:

- full immutable action SHAs plus version comments;
- discovery of both `.yml` and `.yaml`;
- exact workflow/job permission allowlists;
- default-deny permissions;
- R2 credentials only on R2 mutation steps;
- GitHub write token only on GitHub tag/Release/asset steps;
- no step with both credential classes;
- beta mutable phases guarded by a fresh default-branch-head check;
- nightly and ordinary CI remain read-only.

If a monolithic release helper currently requires both GitHub and R2 credentials, split its phase interface. Do not broaden the job environment to avoid the split.

## Step 5 — Consolidate publication phases

Refactor the release tooling only as needed to support phase-specific credentials while preserving #1022's transaction:

1. credential-free policy and artifact validation;
2. GitHub-only tag/Release target verification or creation;
3. R2-only immutable upload/verification;
4. GitHub-only immutable asset mirror/verification;
5. R2-only installers and pointer promotion;
6. rollback as R2-only verified pointer mutation.

Each phase must be independently idempotent and must revalidate its inputs. Existing mismatched immutable state fails closed. Remote errors other than confirmed absence must not enter create paths.

For beta, recheck default-branch freshness immediately before the GitHub mirror, installers, and pointer promotion.

## Step 6 — Consolidate packer and manifest behavior

The final packer must produce exactly:

- `prime-agent-<version>.tgz`;
- `prime-agent-ai-<version>.tgz`;
- `prime-agent-core-<version>.tgz`;
- `prime-agent-tui-<version>.tgz`;
- `SHA256SUMS`;
- the channel manifest with version, channel, complete source SHA, artifact names, and hashes;
- existing stable/beta compatibility pointer payloads.

The package contract, source-SHA verifier, publication logic, and documentation must share the same artifact set. Add a regression that fails when any one consumer drifts.

## Step 7 — Focused verification

Run from the appropriate package or repository root:

1. Workflow security contract:
   - `node --test packages/coding-agent/scripts/check-workflow-security.mjs`
2. Release lifecycle/publication/workflow regressions:
   - use the integrated `npm run release:test` command or the exact `node --test` file list it defines;
3. Exact-SHA workflow regressions:
   - `node --test scripts/release-workflow.test.mjs` when not already included by `release:test`;
4. AI branding:
   - `cd packages/ai && npx tsx ../../node_modules/vitest/dist/cli.js --run test/cli-branding.test.ts`;
5. Coding-agent package documentation:
   - run the exact changed test from `packages/coding-agent` using the repository Vitest entrypoint;
6. Complete Python runtime:
   - sync the explicit test group from `prime-agent-runtime/uv.lock` using uv 0.11.33 and CPython 3.11.15;
   - run all `prime-agent-runtime/test/test_*.py` tests and require 64/64 or the current complete discovered count with zero collection errors/skips;
7. YAML parse and `git diff --check`.

Every changed or new test file must be run directly and pass before proceeding.

## Step 8 — Full repository validation

Run `npm run check` and capture the full output. Fix every error, warning, and informational diagnostic. Confirm the command does not change tracked or staged files by comparing full binary worktree/index snapshots before and after, following #968's established contract.

Do not run `npm test`, `npm run build`, or `npm run dev` locally.

## Step 9 — Security and integration review

Review the complete diff against the approved spec, not merely the four source PRs. Required review questions:

- Can an untrusted issue comment or branch ref acquire release concurrency, an environment, write permission, or a secret?
- Can any failed/cancelled/skipped/wrong-SHA CI state reach publication?
- Can a retry overwrite an immutable object, move a tag, or regress a pointer?
- Can stale beta work update any mutable surface?
- Can one step access both R2 and GitHub write credentials?
- Do packer, manifest, checksum, clean-install tests, and publication enumerate the same four artifacts?
- Can an old tag be retried with current protected tooling and exact tagged source?
- Are the original public stable/beta paths and manifest shapes preserved?

Address every Critical, Important, and Minor finding, then rerun affected focused tests and full `npm run check`.

## Step 10 — Commit and draft PR

Stage only explicitly changed integration files. Commit with closing references for #926, #927, #934, and #949. Push normally to `fettpl/prime-agent`; never force-push.

Open a draft PR to `PrimeIntellect-ai/prime-agent:main` that:

- references PRs #1019, #1020, #1022, and #1024 as reviewed source work;
- states it is the intended merge target;
- lists preserved security, release, exact-SHA, and package contracts;
- includes exact local verification results;
- states that no release workflow, tag, upload, publication, pointer update, readiness transition, or merge occurred.

Keep the original PRs unchanged. Do not mark the integration PR ready or notify maintainers until exact-head GitHub CI is fully green and final review is clean.

## Done criteria

- The approved integration design is implemented without `workflow_dispatch` or tag-push publication.
- The four original issue contracts are simultaneously enforced by tests.
- All focused tests, the complete Python suite, YAML/diff checks, and `npm run check` pass.
- Independent exact-head review is clean.
- A draft integration PR exists at the reviewed SHA with fully green CI.
- No release-side mutation or merge occurred.
