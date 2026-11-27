import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { THREAD_SUGGESTIONS } from "#/domain/y-squared";
import { ThreadEmptyState, ThreadEmptyView } from "./thread-empty-state";

const noop = () => undefined;
const view = (state: "shown" | "offer" | "none" | "loading") =>
	renderToStaticMarkup(
		<ThreadEmptyView
			state={state}
			onSend={noop}
			onDismiss={noop}
			onShowAgain={noop}
		/>,
	);

it("offers first things to ask, with a way to dismiss them", () => {
	const html = view("shown");
	for (const text of THREAD_SUGGESTIONS) expect(html).toContain(text);
	expect(html).toContain("Ready when you are");
	expect(html).toContain("Don&#x27;t show again");
});

it("shows only a quiet link to a returning user", () => {
	const html = view("offer");
	for (const text of THREAD_SUGGESTIONS) expect(html).not.toContain(text);
	expect(html).toContain("Show suggestions");
});

it("renders neither while the choice or the chat lists are loading", () => {
	const html = view("loading");
	for (const text of THREAD_SUGGESTIONS) expect(html).not.toContain(text);
	expect(html).not.toContain("Show suggestions");
	expect(html).toContain("Ready when you are");
});

it("server-renders without suggestions (the first paint matches hydration)", () => {
	vi.stubGlobal("localStorage", undefined);
	const html = renderToStaticMarkup(
		<ThreadEmptyState
			onSend={noop}
			userId="u"
			projectCount={1}
			chatCount={0}
		/>,
	);
	for (const text of THREAD_SUGGESTIONS) expect(html).not.toContain(text);
	vi.unstubAllGlobals();
});
