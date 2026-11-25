import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { THREAD_SUGGESTIONS } from "#/domain/y-squared";
import { ThreadEmptyState } from "./thread-empty-state";

it("offers first things to ask in a fresh thread", () => {
	const html = renderToStaticMarkup(
		<ThreadEmptyState onSend={() => undefined} />,
	);
	for (const text of THREAD_SUGGESTIONS) expect(html).toContain(text);
	expect(html).toContain("Ready when you are");
});
