
Claude finished the response
I want you to write the security policy cum .md for the [https://github.com/PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/new/main) so now write,

Failed to fetch: https://github.com/PrimeIntellect-ai/prime-agent
Failed to fetch: https://github.com/PrimeIntellect-ai/prime-agent
Claude’s response was interrupted.
I want you to write the security policy cum .md for the [https://github.com/PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/new/main) so now write


Searched the web
Searched the web
I have a good picture of the project now. Let me check whether Prime Intellect has a published security contact so the disclosure section points to the right place.


Searched the web
Searched the web
I found Prime Intellect's official security policy. Let me pull it so the SECURITY.md aligns with their actual disclosure process rather than inventing one.


Synthesized security framework and architected comprehensive threat model documentation
Synthesized security framework and architected comprehensive threat model documentation
Prime Intellect's public policy routes all vulnerability reports to security@primeintellect.ai, so I'll build the SECURITY.md around that real contact. The most important thing for this particular project is getting the security model right: prime-agent executes model-generated code with your user permissions and is explicitly not a sandbox, so a good policy has to draw a sharp line between an actual vulnerability and expected-by-design behavior. Here's the file.


Created a file, read a file
Created a file, read a file
Here's a SECURITY.md tailored to prime-agent. A few notes on the choices I made, since this project isn't a typical library:

Reporting routes to the real contact. Prime Intellect's published policy only accepts vulnerability reports at security@primeintellect.ai, so that's the primary channel, with GitHub Private Vulnerability Reporting as the second. I deliberately did not invent SLA day-counts (e.g. "we respond in 48 hours"), since committing the project to timelines it hasn't published would be misleading — I described the process stages instead.

The Security Model section is the important part. The biggest "security" fact about prime-agent is a design property, not a bug: it runs model-generated code with your user permissions and the worker/kernel are explicitly not a sandbox. The README even carries that warning. A policy that didn't state this would generate a flood of "the agent ran a dangerous command!" reports that aren't vulnerabilities. So I drew a hard in-scope / out-of-scope line — prompt injection from a repo you pointed it at is expected behavior; a bypass of the installer's checksum verification or the immutable base prompt is a real vulnerability.

In-scope items map to the project's actual guarantees — installer integrity, base-prompt immutability, autonomous-mode budgets, credential handling (~/.prime/agent/auth.json), RPC/JSON/ACP modes, agent-to-agent messaging. Those are the things the design promises, so those are what a report can meaningfully violate.

Two things you may want to adjust before committing:

The Supported Versions table assumes latest-only support with no backports. If Prime Intellect does maintain release branches, swap that in.
I scoped the doc to the open-source project and pointed the *.primeintellect.ai infrastructure at the company's separate policy. If they'd rather have one unified policy, that note can be removed.

Security
Document · MD 


Want to be notified when Claude responds?

c


Claude is AI and can make mistakes. Please double-check cited sources.


Security · MD
# Security Policy
 
Prime Agent is an open-source coding and research agent that runs a persistent
Python control environment, spawns subagents, and executes model-generated code
and project commands **with your user permissions**. Because of this design, the
security posture of Prime Agent depends heavily on *how* and *where* you run it.
Please read the [Security Model](#security-model) section before reporting an
issue — several behaviors that look alarming are intentional and documented.
 
## Reporting a Vulnerability
 
**Do not open a public GitHub issue, pull request, or discussion for security
vulnerabilities.** Public disclosure before a fix is available puts every user at
risk.
 
Report vulnerabilities through either of the following private channels:
 
- **Email:** [security@primeintellect.ai](mailto:security@primeintellect.ai)
- **GitHub Private Vulnerability Reporting:** Use the **Security** tab of this
  repository → **Report a vulnerability** (GitHub Security Advisories).
To help us triage and reproduce quickly, please include as much of the following
as you can:
 
- A clear description of the vulnerability and its impact.
- The Prime Agent version (`prime-agent --version`) and how it was installed
  (release installer, from source, etc.).
- Operating system and architecture (Linux/macOS, x86_64/arm64).
- The provider/model in use, if relevant to the issue.
- Step-by-step reproduction instructions, including any prompts, repository
  contents, skills, extensions, or configuration required.
- A minimal proof-of-concept where possible.
- Any relevant logs, stack traces, or transcripts (with secrets redacted).
Please report only vulnerabilities you have discovered yourself, and do not
access, modify, or exfiltrate data that is not your own while investigating.
 
### What to expect
 
We handle reports in good faith and follow responsible-disclosure practices.
After you submit a report we will aim to:
 
1. **Acknowledge** receipt of your report.
2. **Triage** and confirm the issue, and let you know whether we consider it in
   scope.
3. **Remediate** validated vulnerabilities and prepare a fix and release.
4. **Disclose** the issue publicly once a fix is available, crediting you if you
   wish (see below).
We ask that you give us a reasonable period to investigate and remediate before
any public disclosure, and that you coordinate the timing of any disclosure with
us. If you would like credit in the release notes or advisory, tell us the name
or handle you would like us to use; if you prefer to remain anonymous, we will
respect that.
 
## Supported Versions
 
Prime Agent is under active development and ships frequent releases. Security
fixes are applied to the **latest release on the `main` branch**, and we
generally do **not** backport fixes to older versions.
 
| Version                       | Supported          |
| ----------------------------- | ------------------ |
| Latest release (`main`)       | :white_check_mark: |
| Older / pinned releases       | :x:                |
 
If you are running a pinned or older version, please upgrade before reporting an
issue to confirm it still reproduces:
 
```
prime-agent update [--force]
```
 
## Security Model
 
Understanding the trust boundaries is essential to deciding whether a behavior is
a vulnerability or expected operation.
 
- **Prime Agent executes model-generated code with your permissions.** The
  persistent IPython kernel is a *control environment*, not a jail. File
  operations, shell commands, tool use, subagents, and context management all run
  as your user, with your filesystem access, network access, and credentials.
- **Worker and kernel processes are not a security sandbox.** They exist to
  improve lifecycle isolation, recovery, and stability — they do **not** contain
  or constrain what executed code is allowed to do.
- **Inputs are treated as trusted.** Repositories, instructions, prompts, skills,
  extensions, subagent specifications, and continual-harness state are executed or
  acted upon as if you authored them. Prime Agent is designed to operate on
  content you trust.
- **The base system prompt is immutable.** `/refine` and the Continual Harness can
  update *supplemental* state (memories, skill descriptions, subagent specs) with
  recorded, reversible history, but never rewrite the immutable base prompt.
- **Autonomous mode is bounded, not verified.** `/autonomous`, goals, heartbeats,
  and schedules operate within configured turn, token, and time budgets. Reaching
  a budget limit does not imply the task succeeded, and a passed quality gate only
  verifies what that gate checks.
### Operating Prime Agent safely
 
Because executed code runs with your permissions, the safety of a session is
largely determined by the environment you give it. We strongly recommend:
 
- Run untrusted code, repositories, prompts, skills, or instructions **only** in an
  external sandbox, container, VM, or otherwise restricted environment.
- Work in a disposable clone, clean worktree, or another checkpoint you can inspect
  and roll back (e.g. `git`).
- Review changes, generated code, and installed skills/extensions before trusting
  their output — treat third-party skills and extensions as executable code.
- Scope provider credentials and API keys narrowly, and avoid exposing secrets you
  do not want the agent to be able to read or use.
- Be deliberate about network access and background continuity (daemon-backed
  sessions, agent-to-agent messaging, schedules) in shared or sensitive
  environments.
## Scope
 
### In scope
 
Security issues that undermine an expectation the design is meant to guarantee,
including but not limited to:
 
- Vulnerabilities in the release installer or update mechanism, such as failures in
  checksum/integrity verification, or a path that allows code to be installed or
  executed without the expected verification.
- Bypasses of the **immutability of the base system prompt**, or of the recorded,
  reversible nature of `/refine` / Continual Harness updates.
- Bypasses of **autonomous-mode budgets** (turn, token, or time limits) or of
  user-defined quality gates.
- Unintended disclosure or leakage of provider credentials, API keys, or auth
  files (e.g. `~/.prime/agent/auth.json`) to logs, transcripts, other sessions, or
  other agents.
- Privilege escalation *beyond the invoking user's permissions*, or escape from a
  restriction Prime Agent explicitly claims to enforce.
- Cross-session or cross-agent data exposure that is not expected in the documented
  messaging/continuity model.
- Memory-safety, injection, or parsing bugs in Prime Agent's own code (RPC/JSON
  modes, ACP mode, connection handling, etc.).
- Supply-chain issues in Prime Agent's dependencies that are exploitable through
  normal use.
### Out of scope (expected behavior)
 
The following are **intentional design properties**, not vulnerabilities:
 
- Prime Agent executing model-generated code, shell commands, or project commands
  with your user permissions.
- The worker/kernel processes not sandboxing executed code.
- Prime Agent reading, writing, or deleting files in the working directory it was
  started in.
- Prime Agent acting on prompts, repositories, skills, extensions, or subagent
  specifications that you provided or pointed it at, including harmful behavior
  caused by **untrusted input you chose to trust** (for example, prompt injection
  from a repository or web content you asked it to process). Running untrusted
  content outside a sandbox is a usage decision, not a product vulnerability.
- Autonomous mode continuing work up to its configured budgets, or a passed gate
  not implying overall task success.
Also generally out of scope:
 
- Vulnerabilities requiring a compromised host, malicious local user, or physical
  access already able to act as your user.
- Findings from automated scanners without a demonstrated, realistic exploit.
- Denial of service that requires you to run code you already control.
- Social-engineering, spam, or issues in third-party providers/models themselves
  (report those to the respective provider).
> Prime Intellect's public infrastructure (its website and API endpoints at
> `*.primeintellect.ai`) is covered by the company's separate infrastructure
> security policy. Testing against production infrastructure must not disrupt
> service availability or compromise other users' data. This document covers the
> **prime-agent** open-source project specifically.
 
## Disclosure Policy
 
We practice coordinated disclosure. We ask reporters to keep vulnerability details
private until a fix is released and we have agreed on a disclosure timeline. Once a
fix is available, we will publish a security advisory for this repository and note
the fix in the release notes, crediting the reporter where desired.
 
Thank you for helping keep Prime Agent and its users safe.
 
