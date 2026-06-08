> pi can help you create pi packages. Ask it to bundle your skills, prompt templates, or themes.

# Pi Packages

Pi packages bundle skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `pi` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Pi Package](#creating-a-pi-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Pi packages install code and instructions from third parties. Skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # raw URLs work too
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # show installed packages from settings
prime-agent update                   # update Prime Agent and all non-pinned packages
prime-agent update --packages        # update all non-pinned packages only
prime-agent update --self            # update Prime Agent only
prime-agent update --self --force    # reinstall Prime Agent even if current
prime-agent update npm:@foo/bar      # update one package
```

By default, `install` and `remove` write to global settings (`~/.pi/agent/settings.json`). Use `-l` to write to project settings (`.pi/settings.json`) instead. Project settings can be shared with your team, and pi installs any missing packages automatically on startup.

## Package Sources

Pi accepts three source types in settings and `pi install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`prime-agent update`, `prime-agent update --packages`).
- Global installs use `npm install -g`.
- Project installs go under `.pi/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs pin the package and skip package updates (`prime-agent update`, `prime-agent update --packages`).
- Cloned to `~/.pi/agent/git/<host>/<path>` (global) or `.pi/git/<host>/<path>` (project).
- Runs `npm install` after clone or pull if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
pi install git:git@github.com:user/repo

# ssh:// protocol format
pi install ssh://git@github.com/user/repo

# With version ref
pi install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to package directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. Pi loads resources from the package manifest or conventional directories.

## Creating a Pi Package

Add a `pi` manifest to `package.json` or use conventional directories. Include the `pi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Gallery Metadata

The [package gallery](https://pi.dev/packages) displays packages tagged with `pi-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skills"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `pi` manifest is present, pi auto-discovers resources from these directories:

- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. When pi installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Pi bundles core packages for skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

Other pi packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Pi loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shared-skills": "^1.0.1"
  },
  "bundledDependencies": ["shared-skills"],
  "pi": {
    "skills": ["skills", "node_modules/shared-skills/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `pi config` to enable or disable skills, prompt templates, and themes from installed packages and local directories. Works for both global (`~/.pi/agent`) and project (`.pi/`) scopes.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
