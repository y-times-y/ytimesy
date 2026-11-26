import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasOpenContext } from "../canvas/canvas-open-context";
import { AgentMarkdown } from "../sessions/agent-markdown-renderer";
import { ArtifactBlock } from "./artifact-block";

const dashboard = JSON.stringify({
	type: "dashboard",
	title: "edge.here launch, first 5 hours",
	stats: [
		{ label: "X post views", value: 2436 },
		{ label: "Site visitors", value: 70 },
		{ label: "GitHub stars", value: 10 },
	],
	tabs: [
		{
			name: "Traffic",
			type: "bar",
			x: ["0h", "1h", "2h"],
			series: [{ name: "Views", y: [210, 640, 590] }],
		},
		{
			name: "Funnel",
			type: "table",
			columns: ["Step", "Count"],
			rows: [["Views", 2436]],
		},
	],
});
const render = (source: string, streaming = false, open = false) =>
	renderToStaticMarkup(
		<CanvasOpenContext.Provider value={open ? () => undefined : null}>
			<ArtifactBlock
				source={source}
				streaming={streaming}
				fallback={<pre data-testid="fallback">{source}</pre>}
			/>
		</CanvasOpenContext.Provider>,
	);

describe("ArtifactBlock", () => {
	it("draws the stat header, the first tab's chart and a data table for screen readers", () => {
		const html = render(dashboard);
		expect(html).toContain("edge.here launch, first 5 hours");
		expect(html).toContain("2,436");
		expect(html).toContain("GitHub stars");
		expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="[^"]*Views/);
		expect(html).toContain('class="sr-only"');
		expect(html).not.toContain("data-testid");
	});

	it("tabs follow the ARIA tablist pattern with one selected tab", () => {
		const html = render(dashboard);
		expect(html).toContain('role="tablist"');
		expect(html.match(/role="tab"/g)).toHaveLength(2);
		expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
		expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
		expect(html).toMatch(/role="tabpanel"[^>]*aria-labelledby=/);
	});

	it("offers Copy as image always and Expand only where a panel can open", () => {
		expect(render(dashboard)).toContain('aria-label="Copy as image"');
		expect(render(dashboard)).not.toContain("Expand to the canvas panel");
		expect(render(dashboard, false, true)).toContain(
			'aria-label="Expand to the canvas panel"',
		);
	});

	it("draws a table, a checklist and a timeline", () => {
		const table = render(
			JSON.stringify({
				type: "table",
				columns: ["Page", "Visitors"],
				rows: [["/", 41]],
			}),
		);
		expect(table).toContain("<table");
		expect(table).toContain("<th");
		expect(table).toContain("41");
		const checklist = render(
			JSON.stringify({
				type: "checklist",
				items: [{ text: "Ship it", done: true }],
			}),
		);
		expect(checklist).toContain("Ship it");
		expect(checklist).toContain("checked");
		const timeline = render(
			JSON.stringify({
				type: "timeline",
				events: [{ label: "Launch", at: "09:00" }],
			}),
		);
		expect(timeline).toContain("<ol");
		expect(timeline).toContain("09:00");
	});

	it("runs an HTML card only in a script-only sandbox with the offline policy", () => {
		const html = render(
			JSON.stringify({
				type: "html",
				title: "Slider",
				html: "<p>hi</p><script>fetch('/api')</script>",
			}),
		);
		expect(html).toMatch(/<iframe[^>]*sandbox="allow-scripts"/);
		expect(html).not.toContain("allow-same-origin");
		expect(html).toContain("connect-src");
		expect(html).toContain('referrerPolicy="no-referrer"');
		// The model's script is inside the frame's document attribute, never a tag of the page.
		expect(html.replace(/srcDoc="[^"]*"/, "")).not.toContain("<script");
	});

	it("shows a placeholder while the block is still streaming", () => {
		const html = render(dashboard.slice(0, 120), true);
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("data-testid");
	});

	it("falls back to the source when a settled block is not valid", () => {
		expect(render('{"type":"nope"}')).toContain("data-testid");
		expect(render(dashboard.slice(0, 120))).toContain("data-testid");
	});

	it("escapes hostile text and never emits model markup", () => {
		const html = render(
			JSON.stringify({
				type: "dashboard",
				title: "<img src=x onerror=alert(1)>",
				stats: [{ label: "<script>alert(1)</script>", value: "javascript:x" }],
				tabs: [
					{
						name: "</button><script>1</script>",
						type: "table",
						columns: ["<b>x</b>"],
						rows: [['"><svg onload=alert(1)>']],
					},
				],
			}),
		);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<img/i);
		expect(html).not.toMatch(/<svg onload/i);
		expect(html).not.toMatch(/<b>x/);
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("an artifact inside a message", () => {
	it("is drawn from the fenced block, beside the text and the PR chip", () => {
		const html = renderToStaticMarkup(
			<AgentMarkdown
				text={`Views peaked early; see pr:acme/web#8.\n\n\`\`\`artifact\n${dashboard}\n\`\`\`\n\nDone.`}
			/>,
		);
		expect(html).toContain('class="artifact"');
		expect(html).toContain("2,436");
		expect(html).toContain("Views peaked early");
		expect(html).toContain("Done.");
	});

	it("never breaks the message while the block streams in", () => {
		const text = `Here:\n\n\`\`\`artifact\n${dashboard.slice(0, 90)}`;
		const html = renderToStaticMarkup(<AgentMarkdown text={text} streaming />);
		expect(html).toContain("Here:");
		expect(html).toContain('aria-busy="true"');
	});

	it("shows an invalid settled block as code", () => {
		const html = renderToStaticMarkup(
			<AgentMarkdown text={'```artifact\n{"type":"nope"}\n```'} />,
		);
		expect(html).not.toContain('class="artifact"');
		expect(html).toContain("nope");
	});

	it("leaves other fenced blocks alone", () => {
		const html = renderToStaticMarkup(
			<AgentMarkdown text={'```json\n{"type":"bar"}\n```'} />,
		);
		expect(html).not.toContain('class="artifact"');
	});
});
