# Supported SDK and Library Artifacts

## Context

Prime Agent publishes four branded npm-format tarballs with every stable and beta R2 release, but its library documentation currently points at package names that do not resolve from npm. The branded registry names return 404, while the inherited `@earendil-works/pi-*` names resolve releases from another project. The current stable R2 artifacts install successfully and expose the documented branded imports.

## Decision

The R2 release channel is the only supported external distribution path for the SDK and libraries in this change. The supported public package identities are:

| Artifact | Public package/import | Purpose |
| --- | --- | --- |
| `prime-agent-<version>.tgz` | `prime-agent` | CLI and Node.js SDK |
| `prime-agent-ai-<version>.tgz` | `prime-agent-ai` | Provider and model toolkit |
| `prime-agent-core-<version>.tgz` | `prime-agent-core` | Stateful agent runtime |
| `prime-agent-tui-<version>.tgz` | `prime-agent-tui` | Terminal UI primitives |

Stable consumers resolve the version from `stable` or `latest.json`; beta consumers resolve it from `beta` or `beta.json`. Installation uses the resulting immutable `/releases/v<version>/<artifact>` URL. The JSON manifests and per-release `SHA256SUMS` remain the integrity metadata.

The inherited `@earendil-works/pi-*` names remain internal workspace and extension-runtime compatibility specifiers. They are not supported registry install targets. Retiring the legacy local npm publishing commands is explicitly deferred to issue #934.

## Documentation Contract

A canonical SDK/library installation guide will:

- list every supported public artifact, import name, and Node.js requirement;
- provide stable and beta version resolution for POSIX shells and PowerShell;
- install immutable tarball URLs rather than nonexistent registry packages;
- explain SHA-256 verification, lockfile integrity, and reproducible pinning;
- explain that updates require resolving the channel again and installing the new immutable URL;
- distinguish public branded imports from internal inherited compatibility specifiers.

The AI, core, TUI, and SDK entry documentation will link to that guide and use branded imports. Programmatic SDK documentation will import from `prime-agent`; source-only examples may retain inherited workspace specifiers when clearly identified as repository development examples. Extension documentation may retain inherited runtime specifiers, but must not claim they are supported registry packages.

The TUI quick start will be self-contained instead of importing an unpublished test theme. The SDK, AI, core, and TUI quick starts must compile against their packed artifacts.

## AI Command Identity

The AI package will expose `prime-agent-ai` as the supported command while retaining `pi-ai` as a compatibility alias. Help and error output will show `npx prime-agent-ai`; it will not direct users to the unrelated inherited npm package.

## Automated Contract Verification

A repository check dedicated to release packages will run after the existing build in pull-request CI. It will:

1. Pack the four artifacts with the existing release packer and a loopback artifact base URL.
2. Serve the generated immutable artifacts from the same URL shape used by R2.
3. Install each advertised package into a separate clean temporary project.
4. Extract and compile the corresponding documentation quick start against the installed package.
5. Load representative public exports at runtime.
6. Reject reintroduced bare npm install instructions for the nonexistent branded registry packages or the inherited SDK package.

The check will use the repository's existing compiler, a temporary npm cache, and no provider credentials. It will clean all temporary files and terminate the loopback server on success or failure. Ordinary `npm run check` will remain usable without prebuilt `dist` directories; CI will invoke the artifact contract check separately after `npm run build`.

## Failure Handling

The contract check will fail with the affected package and subprocess output when packing, installation, type checking, or runtime loading fails. The loopback server will only serve an allowlist of generated artifact filenames, so unexpected dependency requests fail instead of escaping the temporary artifact root.

Documentation will state that channel pointers are mutable discovery metadata and immutable release URLs are the dependency identity. Consumers should commit the resulting lockfile and should not expect npm semver ranges, dist-tags, or `npm outdated` to update R2 artifacts.

## Non-goals

- Publishing branded packages to npm.
- Renaming source workspace manifests or internal imports.
- Retiring or redesigning legacy local npm publishing commands (#934).
- Changing R2 credentials, upload permissions, release tags, or production release sequencing.
- Providing backward compatibility for unsupported registry installation commands.

## Acceptance Criteria

- All documented external SDK/library installs resolve an artifact from the current stable or beta release.
- Public examples import `prime-agent`, `prime-agent-ai`, `prime-agent-core`, or `prime-agent-tui` as appropriate.
- Inherited names are described only as internal/runtime compatibility specifiers, not install targets.
- Stable and beta discovery, immutable pinning, SHA-256 verification, and update behavior are documented.
- The AI artifact exposes `prime-agent-ai`, retains `pi-ai`, and emits branded help text.
- Clean-project CI installs and validates every packed public artifact and compiles each package quick start.
- Legacy local npm publishing behavior and the production release workflow are unchanged.
