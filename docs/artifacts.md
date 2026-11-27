# Inline artifacts

A reply can hold rich cards: a fenced block whose language is `artifact` and whose body is one JSON object (stat, bar, line, table, timeline, checklist, a tabbed dashboard of those, or an `html` card). Code: `src/domain/artifact.ts` (schema, limits, streaming parse, SVG export, instructions), `src/features/artifacts/` (card, CSS, PNG copy/download), the `code` branch of `agent-markdown-renderer.tsx`.

- **Persisted** as ordinary message text: nothing new to store, no tool, no Durable Object, no machine. Every runner can write one.
- **Taught** by `artifactInstructions()` in the box turn prompts (`agent-turn-instructions.ts`, both shapes), the Claude Code runner prompt (not read-only helpers) and Y² (`ySquaredInstructions`, default for table-like or numeric content and digests of more than about 4 threads; see docs/y.md "Visuals").
- **Safe**: typed JSON validated by one zod schema (unknown fields dropped, text stripped of control and bidi characters and truncated, lists cut to limits: 8 stats, 6 series, 200 points, 12 columns, 200 rows, 6 tabs, 24 items, 64 KB typed, 200 KB html). React draws the SVG and text, so model text is never markup. An `html` card runs only in the canvas frame (`sandbox="allow-scripts"`, opaque origin, offline CSP). Never `allow-same-origin`.
- **Streaming**: JSON that has not closed yet is a placeholder while the reply streams; a settled block that is not valid shows as code. A card that throws falls back to code (`ArtifactBoundary`).
- **Settled replies** with an artifact are drawn by the live renderer, not adopted from server HTML (`settledMarkdownAdoptable`), so tabs work.
- **Expand** opens the card in the canvas panel as `CanvasFocus.document` (a static SVG page, or the html card's own markup). **Copy/Download as image** draws the same SVG to a 2x PNG in the browser.
- Not built: a separate `artifact` tool, the per-message cap of 8, a light theme (the app has none).
