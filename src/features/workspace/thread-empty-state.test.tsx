import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { THREAD_SUGGESTIONS } from "#/domain/y-squared";
import { ThreadEmptyState } from "./thread-empty-state";

const noop = () => undefined;
const render = (chatCount: number | null, projectCount = 1) =>
	renderToStaticMarkup(
		<ThreadEmptyState
			onSend={noop}
			projectCount={projectCount}
			chatCount={chatCount}
		/>,
	);

it("offers first things to ask to a brand-new user", () => {
	const html = render(0);
	for (const text of THREAD_SUGGESTIONS) expect(html).toContain(text);
});

it("draws nothing for a returning user: no copy, no links", () => {
	expect(render(10)).toBe("");
	expect(render(0, 3)).toBe("");
});

it("draws nothing while the chat lists load", () => {
	expect(render(null)).toBe("");
});

it("draws nothing in the Super agent chat", () => {
	expect(
		renderToStaticMarkup(
			<ThreadEmptyState
				onSend={noop}
				projectCount={1}
				chatCount={0}
				superAgent
			/>,
		),
	).toBe("");
});
