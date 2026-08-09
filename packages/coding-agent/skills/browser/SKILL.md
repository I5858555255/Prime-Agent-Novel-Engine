---
name: browser
description: Control a shared real browser (the user's own Chrome/Edge or a managed Chromium) from the kernel. Each agent only sees its own tabs. Use for browsing, automation, scraping, form filling, and page QA. Screenshot-first for vision models; dom()+click_index for text-only models.
---

# Browser

Control a real browser from the IPython kernel. The host owns the single CDP
connection and assigns tabs per agent — you only ever see your own tabs, and
your tabs are closed automatically when your session ends (tabs you adopted
from the user are only released, never closed).

Call the prepared `browser` import directly; every function is async:

```python
await browser.ensure_session()                 # first call connects (may prompt the user once)
await browser.goto_url("https://example.com")
await browser.screenshot()                     # look before you act
```

## What actually works

- **Screenshots first (default path)**: `await browser.screenshot()` to
  understand the page, find targets, and verify every meaningful action.
  Re-screenshot after acting instead of assuming it worked. If the model you
  are running on can see images, ALWAYS prefer screenshot + coordinates over
  DOM probing.
- **Clicking**: read the pixel off the screenshot → `click_at_xy(x, y)` →
  screenshot to verify. Coordinate clicks pass through iframes, shadow DOM,
  and cross-origin content at the compositor level — don't hunt selectors first.
- **Text-only models ONLY**: if `screenshot()` returns `vision_unsupported`,
  switch to `dom()` → indexed element list → `click_index(i)` /
  `fill_index(i, text)`. On vision models, do NOT use dom() as your default
  exploration tool. Re-run `dom()` after navigation or big page changes;
  indexes go stale. dom() covers the FULL page; entries marked [below-fold]
  are off-screen — click_index scrolls to them automatically.
- **DOM reads**: `await browser.js("...")` for inspection and extraction.
  Top-level `return` works; promises are awaited. Don't read small text off
  screenshots.
- **Forms**: `fill_input(selector, text)` (or `fill_index(i, text)`), then
  `press_key("enter")`. Trusted input events drive React/Vue controlled inputs.
- **After goto**: `await browser.js("return document.readyState")` or a short
  `asyncio.sleep`, then screenshot.
- **Scrolling**: `scroll(dy=600)` scrolls down, `scroll(dy=-600)` up. It's
  JS-based and works on background tabs; pass x/y to scroll a specific panel.
- **Troubleshooting**: `drain_events()` shows network/page lifecycle events;
  `page_info()` is the cheapest "is this tab alive?" check.
- **Raw CDP**: `await browser.cdp("Domain.method", {...})` for anything the
  helpers don't cover (e.g. `Accessibility.getFullAXTree`).
- **Switching browsers**: if the user asks to use a different browser, call
  `await browser.reconnect()` — the user gets the connection choices again.

## Tabs you own vs tabs the user owns

- `ensure_session()` / `new_tab(url)` create fresh tabs assigned to you. A new
  tab automatically becomes your **focused tab**: all targetless calls act on
  it. Use `focus_tab(target_id)` to switch context between your tabs, or pass
  `target_id=` explicitly to any call. `list_tabs()` marks yours with
  `focused: true`. Focus is never brought to the front — everything runs in
  the background without disturbing the user.
- `list_tabs()` shows only your tabs. The **main agent** may also
  `list_tabs(scope="all")` to see the user's open tabs and
  `attach_tab(target_id)` to adopt one — e.g. when the user asks to "summarize
  the page I have open". Pass `include_active=True` when you need the marker
  for which tab the user is looking at (it briefly inspects user tabs and may
  trigger the browser's consent popup — off by default for that reason).
  Adopted tabs are never closed by the agent lifecycle. Child agents cannot
  adopt.
- You get at most 5 tabs; `close_tab()` ones you're done with.
- Errors are structured: `[NOT_OWNER]`, `[TAB_DESTROYED]`, `[QUOTA_EXCEEDED]`,
  `[ADOPT_NOT_ALLOWED]`, `[STALE_INDEX]`, `[NOT_CONNECTED]`. On
  `TAB_DESTROYED` just open a new tab; on `STALE_INDEX` re-run `dom()`.

## Gotchas

- **Auth wall**: redirected to a login page → stop and ask the user. Never
  type credentials.
- First use may prompt the user to pick a connection mode (their running
  browsers are listed by name — Chrome/Edge/Brave — plus launching a managed
  one or a custom endpoint). Their choice is persisted; later calls connect
  silently.
- Coordinates are CSS pixels in the viewport — exactly what screenshots and
  `dom()` report. `page_info()` gives the current scroll offset.
- Don't activate/focus tabs; everything works on background tabs.
