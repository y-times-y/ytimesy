import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatHeaderTitle } from "./chat-header-title";

it("shows the Super agent's mark and name once, never the stored Y² title", () => {
	const html = renderToStaticMarkup(
		<ChatHeaderTitle superAgent listedTitle="Y²" sessionTitle="Y²" />,
	);
	expect(html.match(/Super agent/g)).toHaveLength(1);
	expect(html).toContain("<svg");
	expect(
		html
			.replace(/<span class="y2-mark".*?<\/svg><\/span>/s, "")
			.replace(/<[^>]*>/g, ""),
	).toBe("Super agent");
	expect(html).not.toContain("Y²");
});

it("shows a thread's own title with no mark", () => {
	const html = renderToStaticMarkup(
		<ChatHeaderTitle
			superAgent={false}
			listedTitle="Fix it"
			sessionTitle="x"
		/>,
	);
	expect(html).toContain("Fix it");
	expect(html).not.toContain("<svg");
});
