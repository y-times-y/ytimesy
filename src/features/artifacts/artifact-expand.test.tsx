import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CanvasInspector } from "../canvas/canvas-inspector";

it("shows an expanded artifact in the canvas panel, sandboxed, with no chat canvas needed", () => {
	const html = renderToStaticMarkup(
		<CanvasInspector
			canvases={[]}
			focus={{
				title: "Artifact · Launch",
				document: "<!doctype html><p>Expanded</p>",
			}}
			onFocusChange={() => undefined}
		/>,
	);
	expect(html).toContain("Artifact · Launch");
	expect(html).toMatch(/<iframe[^>]*sandbox="allow-scripts"/);
	expect(html).not.toContain("allow-same-origin");
	expect(html).toContain("Expanded");
	expect(html).not.toContain("No canvas yet");
});
