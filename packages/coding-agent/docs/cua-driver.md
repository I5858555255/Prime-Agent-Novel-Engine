# Drive desktop applications with Cua Driver

This guide shows you how to let Prime Agent operate desktop applications on the
current macOS, Windows, or Linux host through the Cua Driver skill.

## Before you start

- Install and authenticate Prime Agent.
- Use an interactive desktop session. Cua Driver operates the host desktop; it
  is not a sandbox.
- Review the [Cua Driver platform requirements](https://cua.ai/docs/how-to-guides/driver/install).

## Install Cua Driver

On macOS or Linux:

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

On Windows PowerShell:

```powershell
irm https://cua.ai/driver/install.ps1 | iex
```

Verify that the installed driver can inspect the current desktop:

```bash
cua-driver --version
cua-driver call list_apps
```

On macOS, grant Accessibility and Screen Recording to the installed Cua Driver
application:

```bash
cua-driver permissions grant
cua-driver permissions status
```

## Install the Prime Agent skill

Create Prime Agent's native skill directory, then ask Cua Driver to install its
version-matched skill pack.

On macOS or Linux:

```bash
mkdir -p ~/.prime/agent/skills
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.prime\agent\skills" | Out-Null
```

Then install and verify the skill:

```bash
cua-driver skills install
cua-driver skills status
```

In an active Prime Agent session, run `/reload`. You can then ask Prime Agent to
use Cua Driver in ordinary language or invoke the skill explicitly:

```text
/skill:cua-driver Open Calculator, compute 6 × 7, and verify the result.
```

Prime Agent calls Cua Driver from its persistent IPython environment. No local
MCP registration is required. To print the current setup instructions from the
installed driver, run:

```bash
cua-driver mcp-config --client prime-agent
```

## Troubleshooting

### The skill is not listed

Confirm that `cua-driver skills status` reports a Prime Agent link, then run
`/reload`. Prime Agent also discovers skills from the shared
`~/.agents/skills/` directory.

### The driver cannot see or control an application

Run `cua-driver doctor`. On macOS, also run `cua-driver permissions status` and
confirm that both Accessibility and Screen Recording are granted to Cua Driver.

### A long-running task loses its target

Ask Prime Agent to take a fresh Cua Driver snapshot before retrying. Window IDs,
snapshot IDs, and element tokens describe observed state and should not be
reused after the desktop changes.

## Related documentation

- [Prime Agent skills](skills.md)
- [Prime Agent RLM programming model](rlm.md)
- [Cua Driver agent connection guide](https://cua.ai/docs/how-to-guides/driver/connect-your-agent)
- [Cua Driver action policy](https://cua.ai/docs/reference/cua-driver/action-selection-policy)
