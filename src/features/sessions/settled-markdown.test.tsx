import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { SessionTimeline } from "./session-timeline";
import { settledMarkdownAdoptable } from "./settled-markdown";

describe("settledMarkdownAdoptable", () => {
	it("adopts replies whose server HTML needs no React", () => {
		expect(settledMarkdownAdoptable("Done. See `a.ts`.", null)).toBe(true);
		expect(settledMarkdownAdoptable("Done.", { agents: [] })).toBe(true);
	});
	it("keeps agent chips and Mermaid diagrams live", () => {
		expect(settledMarkdownAdoptable("Ask build-1", { agents: [{}] })).toBe(
			false,
		);
		expect(settledMarkdownAdoptable("```mermaid\ngraph TD\n```", null)).toBe(
			false,
		);
	});
});

it("marks a settled reply's server HTML for adoption, not a streaming one", () => {
	const reply = (streaming: boolean) =>
		renderToStaticMarkup(
			<SessionTimeline
				items={[
					{ kind: "userMessage", id: SessionItemId("u1"), text: "Hi" },
					{
						kind: "agentMessage",
						id: SessionItemId("a1"),
						text: "Hello",
						streaming,
					},
				]}
				turnStatus={streaming ? "running" : "completed"}
			/>,
		);
	expect(reply(false)).toContain('data-md-key="a1:0" data-md-settled=""');
	expect(reply(true)).toContain('data-md-key="a1:0"');
	expect(reply(true)).not.toContain("data-md-settled");
});
