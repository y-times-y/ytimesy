# Canvas viewer

The Canvas panel is a camera on a design, like a design tool's infinite
canvas. Code: `src/features/canvas/canvas-stage.tsx` (the camera and the pin
overlay), `canvas-zoom-bar.tsx` (controls), `src/domain/canvas-viewport.ts`
(the arithmetic: fit, zoom, clamping, anchoring; tested).

## How a document is shown

- The sandboxed frame is laid out at the document's **natural size** and moved
  and scaled with a CSS transform on a wrapper (never bitmap scaling), so text
  stays crisp. The frame is never scrolled; the camera moves instead.
- The bridge (`CANVAS_BRIDGE_SCRIPT`) reports the size: the box around every
  `data-artboard` element, plus the document's scroll size. The viewer fits the
  artboards box, else the scroll size. A document with no artboards is laid out
  1280 px wide (the width presets in the bar change that: 1440, 768, 390).
- It opens **fitted to the panel** (never enlarged past 100%), hidden until
  placed so nothing jumps. The camera (fit, or zoom and pan) is remembered per
  canvas title for the page's life and survives revision changes.
- Pinned notes use the same transform (`anchorBox`): pins stay on their
  elements while zooming and panning; pin size stays constant on screen.

## Controls

| Action | Input |
| --- | --- |
| Zoom in / out | `−` `+` buttons, Ctrl/Cmd `+` `-`, pinch or Ctrl+wheel (around the cursor) |
| Fit to panel | Fit button, the percentage menu, Ctrl/Cmd `0` |
| Presets | 50%, 100%, 200% in the percentage menu |
| Pan | two-finger scroll or wheel, middle-button drag, Space + drag, drag the background |
| Expanded view | the expand button; Esc leaves it |

Wheel, key and drag events inside the frame cannot reach the app, so the
bridge forwards them as strict messages (`wheel`, `zoomkey`, `space`, `pan`,
`size` in `canvas-annotation.ts`); the app validates each like every other
canvas message.

## Writing canvases for it

`canvasInstructions` (`src/domain/canvas.ts`) and the `canvas` tool description
tell agents: lay artboards on one wide page (a non-wrapping row), mark each with
`data-artboard`, keep each at a realistic fixed size (page 1440 px, sidebar
300x760, phone 390x844), label them, and never assume the panel is wide.
Canvases that predate this keep working: they are laid out 1280 px wide and
fitted.
