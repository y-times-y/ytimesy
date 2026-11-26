import { describe, expect, it } from "vitest";
import {
	ARTIFACT_HTML_LIMIT,
	ARTIFACT_SPEC_LIMIT,
	artifactDocument,
	artifactInstructions,
	artifactSvg,
	hasArtifactFence,
	parseArtifact,
} from "./artifact";

const bar = {
	type: "bar",
	title: "Views per hour",
	x: ["0h", "1h", "2h"],
	series: [{ name: "Views", y: [210, 640, 590] }],
};
const dashboard = {
	v: 1,
	type: "dashboard",
	title: "Launch, first 5 hours",
	stats: [
		{ label: "X post views", value: 2436 },
		{ label: "Site visitors", value: "70", delta: "+12" },
	],
	tabs: [
		{ name: "Traffic", ...bar },
		{
			name: "Pages",
			type: "table",
			columns: ["Page", "Visitors"],
			rows: [
				["/", 41],
				["/docs", 17],
			],
		},
		{
			name: "Steps",
			type: "checklist",
			items: [{ text: "Post", done: true }, { text: "Reply" }],
		},
		{
			name: "When",
			type: "timeline",
			events: [{ label: "Launch", at: "09:00", status: "done" }],
		},
	],
};
const parse = (value: unknown, streaming = false) =>
	parseArtifact(JSON.stringify(value), { streaming });
const ready = (value: unknown) => {
	const result = parse(value);
	if (result.status !== "ready") throw new Error(JSON.stringify(result));
	return result.artifact;
};

describe("parseArtifact: valid specs", () => {
	it("accepts every type", () => {
		expect(ready(bar).type).toBe("bar");
		expect(ready({ ...bar, type: "line" }).type).toBe("line");
		expect(
			ready({ type: "stat", stats: [{ label: "Stars", value: 10 }] }).type,
		).toBe("stat");
		expect(
			ready({ type: "table", columns: ["a"], rows: [["x"], [1], [null]] }).type,
		).toBe("table");
		expect(
			ready({ type: "timeline", events: [{ label: "Shipped" }] }).type,
		).toBe("timeline");
		expect(
			ready({ type: "checklist", items: [{ text: "Write tests", done: true }] })
				.type,
		).toBe("checklist");
		expect(ready({ type: "html", title: "Card", html: "<p>x</p>" }).type).toBe(
			"html",
		);
		expect(ready(dashboard).type).toBe("dashboard");
	});

	it("drops unknown fields and inherited-looking keys", () => {
		const source =
			'{"type":"stat","stats":[{"label":"A","value":1,"onclick":"x"}],"__proto__":{"polluted":true},"constructor":{"x":1}}';
		const result = parseArtifact(source);
		expect(result.status).toBe("ready");
		expect(JSON.stringify(result)).not.toContain("onclick");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("cleans control and bidi characters and truncates long text", () => {
		const artifact = ready({
			type: "stat",
			title: `Hi\u0000\u202eevil${"x".repeat(500)}`,
			stats: [{ label: "A", value: 1 }],
		});
		expect(artifact.title?.includes("\u202e")).toBe(false);
		expect(artifact.title?.includes("\u0000")).toBe(false);
		expect((artifact.title ?? "").length).toBeLessThanOrEqual(80);
	});

	it("truncates lists to their limits instead of failing", () => {
		const rows = Array.from({ length: 500 }, (_, i) => [String(i)]);
		const artifact = ready({ type: "table", columns: ["n"], rows });
		expect(artifact.type === "table" && artifact.rows.length).toBe(200);
		const tabs = Array.from({ length: 9 }, (_, i) => ({
			name: `t${i}`,
			type: "checklist",
			items: [{ text: "a" }],
		}));
		const dash = ready({ type: "dashboard", tabs });
		expect(dash.type === "dashboard" && dash.tabs.length).toBe(6);
	});

	it("clamps the HTML card height", () => {
		const high = ready({ type: "html", html: "x", height: 5000 });
		const low = ready({ type: "html", html: "x", height: 1 });
		expect(high.type === "html" && high.height).toBe(600);
		expect(low.type === "html" && low.height).toBe(120);
	});
});

describe("parseArtifact: invalid specs", () => {
	it.each([
		["not JSON", "hello"],
		["an array", "[1,2]"],
		["null", "null"],
		["an unknown type", '{"type":"script","src":"x"}'],
		["no type", '{"stats":[]}'],
		[
			"a newer version",
			'{"v":2,"type":"stat","stats":[{"label":"a","value":1}]}',
		],
		["empty stats", '{"type":"stat","stats":[]}'],
		[
			"a series that does not match x",
			JSON.stringify({ ...bar, series: [{ name: "a", y: [1] }] }),
		],
		[
			"a non-numeric point",
			JSON.stringify({ ...bar, series: [{ name: "a", y: ["1", "2", "3"] }] }),
		],
		[
			"a dashboard tab with html",
			JSON.stringify({
				type: "dashboard",
				tabs: [{ name: "x", type: "html", html: "<b>" }],
			}),
		],
		[
			"a nested dashboard",
			JSON.stringify({
				type: "dashboard",
				tabs: [{ name: "x", type: "dashboard", tabs: [] }],
			}),
		],
	])("rejects %s", (_name, source) => {
		expect(parseArtifact(source).status).toBe("invalid");
	});

	it("rejects a spec over the size limit", () => {
		const big = JSON.stringify({
			type: "table",
			columns: ["a"],
			rows: [["x".repeat(ARTIFACT_SPEC_LIMIT)]],
		});
		expect(parseArtifact(big).status).toBe("invalid");
		const html = JSON.stringify({
			type: "html",
			html: "x".repeat(ARTIFACT_HTML_LIMIT + 10),
		});
		expect(parseArtifact(html).status).toBe("invalid");
	});

	it("never throws on hostile input", () => {
		for (const source of [
			"{".repeat(5000),
			`${"[".repeat(5000)}${"]".repeat(5000)}`,
			'{"type":"bar","x":[1e999],"series":[]}',
			"\u0000",
			"",
		])
			expect(() => parseArtifact(source)).not.toThrow();
	});
});

describe("parseArtifact: streaming", () => {
	const full = JSON.stringify(dashboard, null, 2);

	it("is building for every unfinished prefix while streaming, never invalid", () => {
		for (let end = 0; end < full.length; end += 7) {
			const result = parseArtifact(full.slice(0, end), { streaming: true });
			expect(result.status).toBe("building");
		}
	});

	it("is ready as soon as the JSON closes, and the same when settled", () => {
		expect(parseArtifact(full, { streaming: true }).status).toBe("ready");
		expect(parseArtifact(full).status).toBe("ready");
	});

	it("an unfinished block that never closes is invalid once settled", () => {
		expect(parseArtifact(full.slice(0, 40)).status).toBe("invalid");
	});

	it("a complete-but-wrong spec is invalid even while streaming", () => {
		expect(parse({ type: "nope" }, true).status).toBe("invalid");
	});
});

describe("export and expand documents", () => {
	const hostile = {
		type: "table",
		title: '"><img src=x onerror=alert(1)><script>alert(1)</script>',
		columns: ["<b>a</b>"],
		rows: [["javascript:alert(1)"], ["</text><script>x</script>"]],
	};

	it("escapes every model string in the SVG", () => {
		const svg = artifactSvg(ready(hostile));
		expect(svg).not.toMatch(/<script/i);
		expect(svg).not.toMatch(/<img/i);
		// Only the tags the exporter itself writes exist.
		const tags = new Set([...svg.matchAll(/<\/?([a-z]+)/gi)].map((m) => m[1]));
		for (const tag of tags)
			expect(["svg", "title", "rect", "text", "g", "line"]).toContain(tag);
		expect(svg).toContain("&lt;script&gt;");
		expect(svg.startsWith("<svg")).toBe(true);
	});

	it("draws bars, lines, stats, lists and tabs", () => {
		const svg = artifactSvg(ready(dashboard));
		expect(svg).toContain("<rect");
		expect(svg).toContain("2,436");
		expect(svg).toContain("Traffic");
		expect(svg).toContain("Reply");
		expect(artifactSvg(ready({ ...bar, type: "line" }))).toContain("<path");
	});

	it("expands to a static document with no script and no external load", () => {
		const html = artifactDocument(ready(dashboard));
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/(src|href)=/i);
		expect(html).toContain("<svg");
	});

	it("passes an HTML card through untouched; the sandbox is the frame's job", () => {
		const artifact = ready({ type: "html", html: "<p>hi</p>" });
		expect(artifactDocument(artifact)).toBe("<p>hi</p>");
	});
});

describe("hasArtifactFence", () => {
	it("finds an artifact fence but not other fences", () => {
		expect(hasArtifactFence("a\n```artifact\n{}\n```")).toBe(true);
		expect(hasArtifactFence("a\n~~~ artifact\n{}")).toBe(true);
		expect(hasArtifactFence("```json\n{}\n```")).toBe(false);
		expect(hasArtifactFence("the artifact is ready")).toBe(false);
	});
});

describe("artifactInstructions", () => {
	it("names the fence, the types and the limits", () => {
		const text = artifactInstructions();
		expect(text).toContain("```artifact");
		for (const type of [
			"stat",
			"bar",
			"line",
			"table",
			"timeline",
			"checklist",
			"dashboard",
			"html",
		])
			expect(text).toContain(`"${type}"`);
		expect(text).toContain("no network");
	});
});
