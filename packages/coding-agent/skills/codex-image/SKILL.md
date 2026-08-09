---
name: codex-image
description: Generate and refine images with Codex native image generation, present every version in the conversation, and export only a user-approved version. Use for icons, logos, mockups, illustrations, concepts, and all other image creation requests.
---

# Codex Image

Use this skill for every image-creation request. It runs the installed Codex CLI
with native `image_generation`; it never substitutes Pillow, SVG, canvas, or any
other procedural renderer.

Every generated or refined version is stored under the current
`RLM_SESSION_DIR` and automatically presented in the conversation with
`rlm.host_request("artifact.present", ...)`. Do not copy a version into a
repository until the user has seen it and explicitly approved it.

## API

The prepared import is `codex_image`:

```python
version = await codex_image.generate(
    "A crisp app icon for an encrypted notes product",
    kind="icon",
    references=["/path/to/reference.png"],
)

refined = await codex_image.refine(
    version["workflow_id"],
    "Keep the keyhole but simplify the outer silhouette",
)

versions = codex_image.list_versions(version["workflow_id"])

# Call only after the user explicitly approves this exact version.
exported = codex_image.approve(
    version["workflow_id"],
    refined["version"],
    "assets/app-icon.png",
    approved=True,
)
```

`generate` defaults to `kind="image"` and requests exactly one image. Pass
`kind="icon"` for an icon. For a mockup, pass `kind="mockup"`; the default output is one comparison-sheet image
containing three clearly labeled directions (A, B, and C), not three separate
files. Use a fresh `generate` call for a new concept and `refine` to continue the
same Codex thread.

`list_versions()` lists every workflow in the current session, while
`list_versions(workflow_id)` limits the result to one lineage. Versions, captured references, prompts, hashes, parent links, Codex thread IDs,
and manifests are immutable.

`approve` refuses to copy unless the keyword argument is exactly
`approved=True`. Approval writes the requested target atomically and records an
immutable approval receipt. It will not replace an existing target unless the
caller also passes `overwrite=True`. Never infer
approval from positive feedback, and never call it before the generated image
has been presented to the user.

By default the skill resolves `codex` from `PATH`. For tests or managed
installations, pass `command=["/path/to/codex"]` (including any command prefix
arguments) or set `CODEX_IMAGE_COMMAND`. Prompts always travel over stdin, and
CLI stdout/stderr stay captured unless an error must be reported.

## Failure and cleanup semantics

If Codex is missing, unauthenticated, times out, exits non-zero, returns no new
native raster path, or presentation fails, the call raises a focused exception,
removes the incomplete workflow/version, and never creates a repository asset.
A failed refinement leaves every completed prior version untouched. The skill
never invokes a fallback image renderer. `approve` re-hashes the selected
version against its presented manifest and persists the immutable approval
receipt before mutating the target; an export failure can therefore leave a
receipt of the approval attempt, but not an unrecorded repository mutation.

Completed workflows live only under
`$RLM_SESSION_DIR/codex-image/<workflow-id>/`. They intentionally survive for
session replay and approval auditing; remove that workflow directory manually
when its lineage and immutable approval receipts are no longer needed. Codex may
also retain its own native output beneath `$CODEX_HOME/generated_images`; Codex
owns cleanup of that cache.

Reference images are validated, hashed, and captured into the workflow before
Codex runs, so later refinement does not depend on the original reference path.
The reusable package contains no credentials or personal paths: Codex continues
to own authentication and configuration.
