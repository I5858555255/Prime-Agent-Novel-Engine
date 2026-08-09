# Security Policy

## Supported Versions

Security updates are provided for the latest supported version of Prime Agent.

| Version | Supported |
| ------- | --------- |
| Latest release | :white_check_mark: |
| Older releases | :x: |

## Reporting a Vulnerability

If you believe you have discovered a security vulnerability in Prime Agent, please report it privately rather than opening a public GitHub issue.

Please use GitHub's private vulnerability reporting/security advisory mechanism for this repository when available.

When reporting a vulnerability, please provide as much of the following information as possible:

- A clear description of the vulnerability.
- The affected version, commit, or component.
- The steps required to reproduce the issue.
- A minimal proof of concept, if available.
- The potential security impact.
- Any relevant logs, traces, screenshots, or other technical details.
- A suggested mitigation or fix, if you have one.

Please avoid including secrets, API keys, credentials, personal information, or other sensitive data in a report.

## Responsible Disclosure

Please give the maintainers a reasonable opportunity to investigate and address a reported vulnerability before publicly disclosing the issue.

We ask security researchers and contributors to:

- Avoid accessing, modifying, or deleting data that does not belong to them.
- Avoid disrupting services or infrastructure.
- Avoid intentionally degrading the availability or performance of systems.
- Avoid social engineering, phishing, or other attacks against project contributors or users.
- Avoid testing against third-party services without authorization.
- Minimize any access to data that is not necessary to demonstrate the vulnerability.
- Stop testing and notify the maintainers if testing could cause significant harm.

Good-faith security research is appreciated. We will make a reasonable effort to investigate valid reports and coordinate remediation and disclosure where appropriate.

## Security Considerations

Prime Agent is an AI agent and coding/research harness capable of interacting with local environments, executing tools, modifying files, and performing other potentially sensitive operations.

Users should therefore:

- Run Prime Agent only in environments they trust and control.
- Review the permissions and capabilities granted to the agent.
- Avoid exposing unnecessary credentials, secrets, private keys, or sensitive files to the agent.
- Use appropriate operating-system and environment-level isolation for untrusted workloads.
- Keep dependencies and the Prime Agent installation up to date.
- Treat model-generated commands, code, and tool calls as potentially untrusted until reviewed.
- Use appropriate network, filesystem, process, and credential restrictions when operating the agent in sensitive environments.

## Third-Party Dependencies

Prime Agent depends on third-party software and services. Security issues in dependencies may affect Prime Agent even when the vulnerability is not directly present in this repository.

Users should keep dependencies up to date and follow the security guidance provided by the maintainers of those dependencies.

## Scope

This policy applies to security vulnerabilities affecting Prime Agent and the code maintained in this repository.

Security issues in external services, third-party dependencies, operating systems, model providers, or other infrastructure should generally be reported to the appropriate upstream maintainer as well. If an external issue has a direct security impact on Prime Agent, please include that context in the report.

## Public Disclosure

Please do not publicly disclose a vulnerability before the maintainers have had a reasonable opportunity to investigate and address it.

Once a vulnerability has been addressed, the maintainers may publish relevant security information, including affected versions, severity, impact, and remediation details, as appropriate.

Thank you for helping keep Prime Agent and its users secure.
