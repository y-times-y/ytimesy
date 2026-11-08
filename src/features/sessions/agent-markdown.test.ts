import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentMarkdown } from "./agent-markdown";
import { AgentMarkdown as Renderer } from "./agent-markdown-renderer";

it("shows a reply as plain text until the renderer chunk has loaded, then renders it", async () => {
	const text =
		"## Heading\n\n*done* citeturn583804search1turn583804search2";
	const element = createElement(AgentMarkdown, {
		text,
		onOpenFile: () => {},
	});
	const before = renderToStaticMarkup(element);
	expect(before).toContain("## Heading");
	expect(before).not.toContain("<h2");
	expect(before).toContain("(source unavailable)");
	expect(before).not.toContain("turn583804search");
	expect(before).not.toContain("");
	for (const fragment of [
		"",
		"cite",
		"citeturn583804search1turn583804se",
	]) {
		const partial = renderToStaticMarkup(
			createElement(AgentMarkdown, {
				text: `Streaming ${fragment}`,
				streaming: true,
			}),
		);
		expect(partial).toContain("Streaming ");
		expect(partial).not.toContain("");
		expect(partial).not.toContain("turn583804");
	}
	// Once loaded, the same component renders through the real renderer.
	await import("./agent-markdown-renderer");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const after = renderToStaticMarkup(element);
	expect(after).toBe(
		renderToStaticMarkup(
			createElement(Renderer, {
				text,
				onOpenFile: () => {},
			}),
		),
	);
	expect(after).toContain("<h2");
});
