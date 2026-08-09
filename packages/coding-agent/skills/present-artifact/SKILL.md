---
name: present-artifact
description: Present a generated image or other supported on-disk artifact to the user without attaching it to the model context. Use when the user should see an artifact before it is exported or committed.
---

# Present Artifact

Present an on-disk artifact in the current Prime Agent conversation:

```python
await present_artifact("/path/to/generated.png")
await present_artifact("/path/to/generated.png", label="Direction A")
```

This is a display-only action for the user. It does not load the artifact into
the model context, upload it, copy it into a repository, or imply approval.
The host validates and captures the artifact so the source file may be removed
after the call succeeds.


The host rejects missing/directories and files larger than 20 MiB. Supported
raster images are decoded and size-bounded for an inline preview; other files
are captured with durable metadata and a local path fallback. Presentation
failures raise an exception and do not imply approval.


Inline raster previews travel with the conversation and render in image-capable
interactive or ACP clients. Generic files currently expose captured metadata
and a host-local path only; this is not a remote file-download channel.
