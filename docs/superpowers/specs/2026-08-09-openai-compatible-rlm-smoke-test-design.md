# OpenAI-Compatible RLM Smoke Test

## Goal

Verify that Prime Agent can use an existing OpenAI-compatible gateway configuration for an end-to-end recursive language model flow.

Success requires all of the following:

1. Prime Agent resolves the configured custom provider and model.
2. The parent model invokes the persistent IPython tool.
3. The parent spawns an RLM child that inherits the same provider and model.
4. The child sends a nonce-bearing reply to the parent.
5. The parent receives that reply and reports `PASS`.

## Isolation

Use the latest stable Prime Agent release with temporary configuration and session directories under the workspace. Do not modify existing user-level agent configuration.

The temporary `models.json` will contain one custom provider and model. It will reference the credential by environment-variable name; no credential value, private endpoint, or authorization header will be copied into a tracked file or printed.

## Test Flow

1. Confirm the configured credential environment variable is present without displaying its value.
2. Install or unpack the stable Prime Agent release inside the workspace.
3. Create an isolated Prime Agent configuration for the custom model.
4. Confirm `prime-agent model list` resolves the expected provider and model.
5. Start a controlled Prime Agent session with the isolated configuration.
6. Prompt the parent to use IPython, spawn one named child, and request an explicit nonce-bearing reply.
7. Capture the parent/child evidence and report the result.

## Failure Handling

Stop at the first failed boundary and report it precisely: installation, configuration parsing, gateway authentication, parent tool calling, child admission, child execution, or parent message receipt. Inspect logs only after redacting credentials, private endpoints, and authorization headers.

## Cleanup

Keep all temporary binaries, configuration, sessions, and captured output under the workspace. No source-code changes or permanent configuration are needed for this compatibility test.
