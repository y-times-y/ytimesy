---
name: no-snap-first-paint
description: Use whenever building or changing frontend UI that is server-rendered but depends on client-only state (localStorage, the clock, screen size, media queries, typed input). Makes the first paint correct so nothing snaps or flickers when React hydrates, and avoids hydration mismatches.
---

# No snap on first paint

Source: Ethan Niser, "A clock that doesn't snap" (https://ethanniser.com/blog/a-clock-that-doesnt-snap/).

## The problem

The server renders HTML without what only the browser knows: localStorage choices (sidebar open, sort, folded groups, pinned items), the current time, the viewport, `prefers-*` media queries, text the user typed before the JS loaded. The first paint shows the server default, then React hydrates and the UI jumps. Reading that state in `useEffect` makes the snap visible; reading it in a `useState` initializer makes the first client render disagree with the server HTML (hydration mismatch).

Nothing inside React runs early enough to fix the first paint. Hydration happens after the browser has already painted.

## The pattern

1. **Inline script right after the element (or early in `<head>` for page-wide state).** It runs during HTML parsing, before first paint, reads the real value and fixes the DOM. Prefer setting data attributes on `<html>` (`data-sidebar="open"`, `data-sort="recent"`) and let CSS style from them, rather than rewriting markup.
2. **Hand the value to React.** The script stores what it decided on `window` (declare it in a global TypeScript interface, e.g. `window.__YT_BOOT__`), and the component's `useState` initializer reads it on the client (falling back to the server default when `typeof window === "undefined"`). React's first client render then matches the DOM, so no mismatch warning and no second jump.
3. **Typed input survives hydration.** Initialize controlled inputs from the DOM element's current value (look it up by id, check `instanceof HTMLInputElement`/`HTMLTextAreaElement`) instead of `""`. No script needed.
4. **Time-based UI** (clocks, "2m ago", progress): compute once in the script, store the timestamp on `window`, and have the script and React both use that one timestamp so they agree.

## Rules

- The inline script is self-contained: no imports, no closures, only globals. Write it as a typed function and inline it with `fn.toString()` wrapped in an IIFE, rendered with `dangerouslySetInnerHTML`.
- Keep it tiny and wrap storage access in try/catch (private mode and blocked storage throw). Never inline a library.
- Its logic duplicates the component's. Keep both in one module (export the parse/default functions and the script together) and test that they agree.
- Place it as early as possible: directly after the element it fixes, or in `<head>` (TanStack Start: `src/routes/__root.tsx`) for `<html>` attributes.
- Server-safe defaults must still render a usable page when the script cannot run.

## Checklist for any new client-only UI state

- Does the server render a different first paint than the user will end up seeing? If yes, apply the pattern.
- Is state read in `useEffect` and then applied? That is a visible snap.
- Is state read in a `useState` initializer from localStorage/`window`? That is a hydration mismatch unless the boot script set the same value first.
- Verify by loading with the setting changed (e.g. sidebar closed, sort "Recent") and a throttled CPU: screenshot the first paint and confirm no console hydration warnings.
