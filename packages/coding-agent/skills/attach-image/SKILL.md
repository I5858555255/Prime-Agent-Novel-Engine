---
name: attach-image
description: Load an on-disk image (PNG, JPEG, GIF, WebP) into multimodal context via the pre-imported IPython callable `attach_image` (not a separate agent tool). On vision-capable models, prefer `print(await attach_image("path.png"))` when the user gives an image path or asks to analyze/see a screenshot, diagram, chart, or photo — do not use PIL/OCR instead. If the model is not vision-capable, skip this skill and fall back to IPython PIL/OCR analysis.
---

# Attach Image

`attach_image` is a **pre-imported Python skill** in the IPython kernel. It is
not a standalone agent tool. Invoke it through `ipython`:

```python
print(await attach_image("diagram.png"))
print(await attach_image("a.png", "b.jpg"))
```

That loads the file into multimodal context the same way a pasted image does,
so a vision-capable model can look at it.

## When to use

- Current model supports images (`input` includes `image`)
- User points at an image file and wants you to look at / analyze / describe it
- Screenshots, diagrams, charts, UI captures, photos, scanned pages

## When NOT to use (IPython fallback)

If the current model is **not** vision-capable, `attach_image` raises. Do not
retry it. Fall back to programmatic analysis in IPython:

```python
from PIL import Image
img = Image.open("diagram.png")
print(img.size, img.mode)
# then OCR / crop / inspect as needed, e.g. tesseract
```

Also use PIL (not `attach_image`) for programmatic pixel work the user asked
for explicitly — resize, crop, hash, compare bytes — even on vision models.

## Rules

- Vision model → prefer `await attach_image(...)` for visual understanding.
- Non-vision model → IPython PIL/OCR fallback; say vision is unavailable.
- Supported formats: PNG, JPEG, GIF, WebP.
- Large images are auto-resized/compressed; originals are left untouched.
