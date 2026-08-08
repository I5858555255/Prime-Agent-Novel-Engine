# SDK and Library Artifacts

Prime Agent distributes its Node.js SDK and libraries as branded npm-format tarballs through the same R2 stable and beta channels as the CLI. These artifacts are the supported external install path; they are not published under the branded names in the npm registry.

## Packages

| Package and import | Artifact | Node.js | Use |
| --- | --- | --- | --- |
| `prime-agent` | `prime-agent-<version>.tgz` | 22.8 or newer | CLI and Node.js SDK |
| `prime-agent-ai` | `prime-agent-ai-<version>.tgz` | 20 or newer | Provider and model toolkit |
| `prime-agent-core` | `prime-agent-core-<version>.tgz` | 20 or newer | Stateful agent runtime |
| `prime-agent-tui` | `prime-agent-tui-<version>.tgz` | 20 or newer | Terminal UI primitives |

`prime-agent-core` examples also use `prime-agent-ai`, and the full SDK guide uses both `prime-agent` and `prime-agent-ai`. Install both artifacts for those cases.

## Install the Current Stable Release

POSIX shell:

```bash
release_base=https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev
release_version="$(curl -fsSL "$release_base/stable")"
package=prime-agent-ai
npm install "$release_base/releases/$release_version/$package-${release_version#v}.tgz"
```

Set `package` to `prime-agent`, `prime-agent-ai`, `prime-agent-core`, or `prime-agent-tui`. Install multiple URLs in one `npm install` command when an example uses more than one package.

PowerShell:

```powershell
$ReleaseBase = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev"
$ReleaseVersion = (Invoke-RestMethod "$ReleaseBase/stable").Trim()
$PlainVersion = $ReleaseVersion.TrimStart("v")
$Package = "prime-agent-ai"
npm install "$ReleaseBase/releases/$ReleaseVersion/$Package-$PlainVersion.tgz"
```

The `stable` pointer contains the active version with its `v` prefix. `latest.json` exposes the same version plus the CLI tarball path and SHA-256 metadata for every package.

## Install a Beta Release

Use the beta pointer instead of the stable pointer:

```bash
release_base=https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev
release_version="$(curl -fsSL "$release_base/beta")"
package=prime-agent-ai
npm install "$release_base/releases/$release_version/$package-${release_version#v}.tgz"
```

In PowerShell, resolve `"$ReleaseBase/beta"` instead. `beta.json` provides the structured beta manifest. Beta versions follow the latest successful `main` build and are not promoted to stable automatically.

## Integrity and Reproducible Installs

Channel pointers are mutable discovery metadata. The resolved `/releases/v<version>/...` URL is immutable and is the dependency identity to commit to `package.json` and `package-lock.json`.

Verify an artifact before installation when you do not want npm to download it directly:

```bash
release_base=https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev
release_version="$(curl -fsSL "$release_base/stable")"
artifact="prime-agent-ai-${release_version#v}.tgz"
release_url="$release_base/releases/$release_version"

curl -fsSLO "$release_url/$artifact"
curl -fsSLO "$release_url/SHA256SUMS"
grep -F "  $artifact" SHA256SUMS > SHA256SUMS.selected
sha256sum -c SHA256SUMS.selected
npm install "./$artifact"
```

On macOS, replace the verification command with `shasum -a 256 -c SHA256SUMS.selected`. On PowerShell, compare `(Get-FileHash -Algorithm SHA256 $Artifact).Hash.ToLower()` with the package's `sha256` value from `latest.json` or `beta.json` before installation.

npm records the resolved URL and integrity in `package-lock.json`. Commit the lockfile so CI and collaborators use the same release.

## Updating

R2 artifacts do not have npm dist-tags or semver range discovery. `npm outdated` does not discover a newer Prime Agent artifact.

To update, resolve `stable` or `beta` again, review the new version and manifest checksum, then rerun `npm install` with the new immutable URL. Review and commit the resulting `package.json` and `package-lock.json` changes. To stay pinned, keep the existing immutable URL.

## Internal Compatibility Names

The source workspace and extension runtime retain `@earendil-works/pi-*` specifiers for compatibility. Those names are internal implementation or extension peer-dependency identifiers, not supported registry install targets for Prime Agent SDK/library consumers. External applications should import only the branded names in the table above.
