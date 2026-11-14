import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { chatCanvases } from "#/domain/canvas";
import { SessionItemId } from "#/domain/ids";
import type { CanvasItem } from "#/domain/session-item";
import { CanvasCard } from "./canvas-card";
import { CanvasFrame } from "./canvas-frame";
import { CanvasInspector } from "./canvas-inspector";
import { CanvasOpenContext } from "./canvas-open-context";

const item = (revision: number, html: string | null = "<h1>Hi</h1>") =>
	({
		kind: "canvas",
		id: SessionItemId(`turn:${revision}`),
		title: "Checkout mockup",
		revision,
		html,
	}) satisfies CanvasItem;

/** Every iframe's sandbox attribute in the markup. */
const sandboxes = (html: string) =>
	[...html.matchAll(/<iframe[^>]*>/g)].map(
		([tag]) => /sandbox="([^"]*)"/.exec(tag)?.[1] ?? null,
	);

it("renders a frame sandboxed to scripts only, never same-origin", () => {
	const html = renderToStaticMarkup(
		<CanvasFrame html="<p>x</p>" title="Preview" />,
	);
	expect(sandboxes(html)).toEqual(["allow-scripts"]);
	expect(html).not.toContain("allow-same-origin");
	expect(html).toContain("Content-Security-Policy");
	expect(html).toContain('referrerPolicy="no-referrer"');
});

it("shows a card with its title, thumbnail and Open, and no revision", () => {
	const html = renderToStaticMarkup(
		<CanvasOpenContext.Provider value={() => undefined}>
			<CanvasCard item={item(2)} latest />
		</CanvasOpenContext.Provider>,
	);
	expect(html).toContain("Checkout mockup");
	expect(html).not.toContain("rev 2");
	expect(html).not.toContain("revision");
	expect(html).toContain(">Open<");
	expect(sandboxes(html)).toEqual(["allow-scripts"]);
	expect(html).toContain('loading="lazy"');
});

it("shows no Open where nothing can open the canvas, and no frame once its HTML is gone", () => {
	const html = renderToStaticMarkup(<CanvasCard item={item(1, null)} latest />);
	expect(html).not.toContain(">Open<");
	expect(html).not.toContain("<iframe");
	expect(html).toContain("no longer kept");
});

it("shows the latest revision in the inspector with the revision switcher", () => {
	const html = renderToStaticMarkup(
		<CanvasInspector
			canvases={chatCanvases([item(1, "<p>one</p>"), item(2, "<p>two</p>")])}
			onFocusChange={() => undefined}
		/>,
	);
	expect(html).toContain("rev 2");
	expect(html).toContain("&lt;p&gt;two&lt;/p&gt;");
	expect(html).not.toContain("&lt;p&gt;one&lt;/p&gt;");
	expect(html).toContain('aria-label="Previous revision"');
	expect(html).toContain('aria-label="Open in new tab"');
	expect(sandboxes(html)).toEqual(["allow-scripts"]);
});

it("shows a chosen older revision", () => {
	const html = renderToStaticMarkup(
		<CanvasInspector
			canvases={chatCanvases([item(1, "<p>one</p>"), item(2, "<p>two</p>")])}
			focus={{ title: "Checkout mockup", revision: 1 }}
			onFocusChange={() => undefined}
		/>,
	);
	expect(html).toContain("&lt;p&gt;one&lt;/p&gt;");
});

it("explains the empty Canvas view", () => {
	const html = renderToStaticMarkup(
		<CanvasInspector canvases={[]} onFocusChange={() => undefined} />,
	);
	expect(html).toContain("No canvas yet.");
});
