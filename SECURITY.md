# Security Policy

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub's private vulnerability reporting](https://github.com/PrimeIntellect-ai/prime-agent/security/advisories/new) and include:

- the affected version or commit;
- reproduction steps or a proof of concept;
- the expected impact and prerequisites;
- any suggested mitigation, if known.

Do not include live credentials, private session data, or data belonging to another person. We will acknowledge the report through the advisory and coordinate disclosure after a fix is available.

## Security Model

Prime Agent is a local coding and research harness, not a sandbox. It intentionally performs high-trust operations:

- model-generated Python runs in a persistent IPython kernel with the permissions of the current user;
- installed extensions execute arbitrary JavaScript or TypeScript in the Prime Agent process;
- skills and prompt templates can influence model behavior and tool use;
- local daemon and worker processes retain session state and coordinate agent execution;
- provider credentials and OAuth tokens are stored in `~/.prime/agent/auth.json`;
- sessions can contain prompts, source code, tool output, filesystem paths, and other sensitive data.

Review third-party extensions, skills, packages, and model endpoints before enabling them. Run Prime Agent with the least OS, repository, network, and credential access appropriate for the task. Do not use untrusted project instructions or session files in a privileged environment.

## In Scope

Examples include credential disclosure, unauthorized local or remote command execution outside documented behavior, trust-boundary bypasses, malicious package or session handling, daemon authentication or isolation failures, and vulnerabilities in the update path.

Prompt injection or a model choosing an unsafe action is not by itself a product vulnerability when it occurs within the documented permissions granted to the agent. Reports are in scope when Prime Agent bypasses an enforced boundary, misrepresents the requested permission, or exposes data or capabilities beyond the configured scope.

## Supported Versions

Security fixes are applied to the latest stable release. Reproduce reports against the latest stable version or current `main` when possible.
