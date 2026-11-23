import { describe, expect, it, vi } from "vitest";
import { applyApiProgress } from "#/domain/api-progress";
import { CANVAS_HTML_LIMIT } from "#/domain/canvas";
import type { SessionItem } from "#/domain/session-item";
import type { CanvasRead } from "../adapters/canvas-read";
import { ySquaredTools } from "./y-squared-tools";

const BASE64 = "B".repeat(20_000);
const html = (body: string) =>
	`<!doctype html><title>Art</title><style>p{color:red}</style><h1>Thread art</h1>${body}<img alt="Cat" src="data:image/png;base64,${BASE64}"><script>1</script>`;

const chat = (over: Record<string, unknown> = {}) => ({
	id: "t1",
	projectId: "p",
	title: "Make art",
	harness: "api",
	listedModelId: "m",
	parentSessionId: null,
	agentRole: null,
	turnStatus: "idle",
	...over,
});

function fixture(
	canvases: Record<string, CanvasRead | null>,
	items: SessionItem[] = [],
) {
	const canvas = vi.fn(async (_user: string, id: string, title: string) =>
		id === "t1" ? (canvases[title] ?? null) : null,
	);
	const metadata = vi.fn(async (_user: string, id: string) =>
		id === "t1"
			? (chat() as never)
			: id === "other"
				? (chat({ id: "other", projectId: "q" }) as never)
				: null,
	);
	const tools = ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		items: () => items,
		deps: {
			canvas: canvas as never,
			metadata: metadata as never,
			crew: () => null,
			list: vi.fn() as never,
		},
	});
	return { tools, canvas, metadata };
}

const call = async (
	tools: ReturnType<typeof ySquaredTools>,
	name: string,
	input: unknown,
) =>
	(
		tools[name] as {
			execute: (input: unknown, options: unknown) => Promise<unknown>;
		}
	).execute(input, { toolCallId: "c", messages: [] });

const modelText = async (
	tools: ReturnType<typeof ySquaredTools>,
	name: string,
	output: unknown,
) =>
	(
		(await (
			tools[name] as unknown as {
				toModelOutput: (a: { output: unknown }) => Promise<{ value: string }>;
			}
		).toModelOutput({ output })) as { value: string }
	).value;

const read = (over: Partial<CanvasRead> = {}): CanvasRead => ({
	itemId: "item-2",
	title: "Thread art",
	revision: 2,
	html: html("<p>Second try</p>"),
	latestRevision: 2,
	...over,
});

describe("read_canvas", () => {
	it("returns the latest revision's text with size, never html or base64, from one read", async () => {
		const f = fixture({ "Thread art": read() });
		const text = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "  Thread   art ",
		})) as string;
		expect(f.canvas).toHaveBeenCalledTimes(1);
		expect(f.canvas).toHaveBeenCalledWith("u", "t1", "Thread art");
		expect(text).toContain('Canvas "Thread art" of "Make art": revision 2');
		expect(text).toContain("KB, has images; part 1 of 1.");
		expect(text).toContain("# Thread art");
		expect(text).toContain("Second try");
		expect(text).toContain("[image: Cat]");
		for (const raw of ["base64", "<p>", "<script", "color:red", "BBBB"])
			expect(text).not.toContain(raw);
		expect(text.length).toBeLessThan(500);
	});

	it("pages a long canvas at 12,000 characters per call", async () => {
		const body = Array.from(
			{ length: 1_200 },
			(_, i) => `<p>paragraph ${i} ${"w".repeat(30)}</p>`,
		).join("");
		const f = fixture({ "Thread art": read({ html: html(body) }) });
		const first = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "Thread art",
		})) as string;
		expect(first).toMatch(/part 1 of [2-9]/);
		expect(first).toContain("[More: call read_canvas with part 2.]");
		expect(first.length).toBeLessThan(12_600);
		const second = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "Thread art",
			part: 2,
		})) as string;
		expect(second).toContain("part 2 of");
		expect(second).not.toContain("paragraph 0 ");
	});

	it("says so for an unknown thread (and another project's), and an unknown canvas", async () => {
		const f = fixture({});
		for (const id of ["missing", "other", "y2"])
			expect(await call(f.tools, "read_canvas", { id, title: "x" })).toBe(
				"No such thread in this project.",
			);
		expect(
			await call(f.tools, "read_canvas", { id: "t1", title: "Nope" }),
		).toContain('has no canvas titled "Nope"');
	});

	it("names the revision it read when the newest one lost its document", async () => {
		const f = fixture({
			"Thread art": read({ revision: 2, latestRevision: 3 }),
		});
		const text = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "Thread art",
		})) as string;
		expect(text).toContain("revision 2");
		expect(text).toContain(
			"newest revision 3 no longer has its document stored",
		);
	});

	it("puts the person's newest feedback before the outline, on the first part only", async () => {
		const f = fixture({
			"Thread art": read({
				feedback:
					'Canvas feedback on "Thread art" (revision 2), 1 note:\n\n1. Bigger cat',
				path: "art/canvas.html",
			}),
		});
		const text = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "Thread art",
		})) as string;
		expect(text).toContain("file art/canvas.html");
		expect(text).toContain("The person's newest feedback on it:");
		expect(text.indexOf("1. Bigger cat")).toBeLessThan(
			text.indexOf("# Thread art"),
		);
	});

	it("reads a bounded window of the HTML source with offset and limit, base64 as placeholders", async () => {
		// The production canvas that failed: 432 KB, mostly inline screenshots.
		const big = `<!doctype html><style>.crop{width:330px}</style><h1>Sidebar</h1>${Array.from(
			{ length: 6 },
			(_, i) =>
				`<figure id="shot-${i}"><img alt="Shot ${i}" src="data:image/png;base64,${"Q".repeat(70_000)}"></figure>`,
		).join("")}<script>done()</script>`;
		const f = fixture({ "Thread art": read({ html: big }) });
		const first = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "Thread art",
			offset: 0,
		})) as string;
		expect(first).toContain("HTML source characters 0–");
		expect(first).toContain(".crop{width:330px}");
		expect(first).toContain('id="shot-0"');
		expect(first).toContain("[data:image/png, 70022 characters]");
		expect(first).not.toContain("QQQQ");
		expect(first).toMatch(/\[More: call read_canvas with offset \d+\.\]/);
		expect(first.length).toBeLessThan(9_000);
		// A window that starts inside a data: URI still shows no base64.
		const inside = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "Thread art",
			offset: 30_000,
			limit: 20_000,
		})) as string;
		expect(inside).not.toContain("QQQQ");
		expect(inside.length).toBeLessThan(21_000);
		// Paging by the given offsets reaches the end.
		let offset = 0;
		let last = "";
		for (let calls = 0; calls < 50; calls++) {
			last = (await call(f.tools, "read_canvas", {
				id: "t1",
				title: "Thread art",
				offset,
				limit: 20_000,
			})) as string;
			expect(last.length).toBeLessThan(21_000);
			const next = /with offset (\d+)\./.exec(last)?.[1];
			if (!next) break;
			offset = Number(next);
		}
		expect(last).toContain("<script>done()</script>");
	});

	it("reads at most CANVAS_HTML_LIMIT characters of a document", async () => {
		const huge = `<p>head</p>${"<p>x</p>".repeat(CANVAS_HTML_LIMIT)}<p>TAIL-END</p>`;
		const f = fixture({ "Thread art": read({ html: huge }) });
		const text = (await call(f.tools, "read_canvas", {
			id: "t1",
			title: "Thread art",
			part: 100,
		})) as string;
		expect(text).not.toContain("TAIL-END");
	});
});

describe("show_canvas", () => {
	it("returns the thread's latest revision with its owner, and the model reads one short line", async () => {
		const f = fixture({ "Thread art": read() });
		const out = (await call(f.tools, "show_canvas", {
			id: "t1",
			title: "Thread art",
		})) as Record<string, unknown>;
		expect(f.canvas).toHaveBeenCalledTimes(1);
		expect(out).toMatchObject({
			shown: true,
			title: "Thread art",
			revision: 2,
			ownerThreadId: "t1",
			ownerItemId: "item-2",
		});
		const confirmation = await modelText(f.tools, "show_canvas", out);
		expect(confirmation).toContain("canvas 'Thread art' (revision 2)");
		expect(confirmation).toMatch(/\d+(\.\d)? KB/);
		expect(confirmation).toContain("Canvas panel");
		expect(confirmation).not.toContain("<");
		expect(confirmation).not.toContain("base64");
		expect(confirmation.length).toBeLessThan(300);
	});

	it("becomes a canvas card in Y²'s own chat that keeps the thread's revision and owner", async () => {
		const f = fixture({ "Thread art": read() });
		const out = await call(f.tools, "show_canvas", {
			id: "t1",
			title: "Thread art",
		});
		let items: SessionItem[] = applyApiProgress([], "turn", {
			type: "tool-call",
			id: "call-1",
			name: "show_canvas",
			input: { id: "t1", title: "Thread art" },
		});
		items = applyApiProgress(items, "turn", {
			type: "tool-result",
			id: "call-1",
			name: "show_canvas",
			output: out,
		});
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: "canvas",
			title: "Thread art",
			revision: 2,
			ownerThreadId: "t1",
			ownerItemId: "item-2",
		});
		// A later revision of the same title is the next card of that canvas.
		const next = await call(
			fixture({
				"Thread art": read({
					revision: 3,
					itemId: "item-3",
					latestRevision: 3,
				}),
			}).tools,
			"show_canvas",
			{ id: "t1", title: "Thread art" },
		);
		items = applyApiProgress(items, "turn", {
			type: "tool-result",
			id: "call-2",
			name: "show_canvas",
			output: next,
		});
		expect(
			items.map((item) => item.kind === "canvas" && item.revision),
		).toEqual([2, 3]);
	});

	it("respects the chat's canvas budget: older revisions drop their html, the newest keeps it", async () => {
		const big = `<p>${"z".repeat(490_000)}</p>`;
		let items: SessionItem[] = [];
		for (const revision of [1, 2, 3, 4, 5]) {
			const f = fixture({
				"Thread art": read({ revision, html: big, itemId: `i${revision}` }),
			});
			items = applyApiProgress(items, "turn", {
				type: "tool-result",
				id: `c${revision}`,
				name: "show_canvas",
				output: await call(f.tools, "show_canvas", {
					id: "t1",
					title: "Thread art",
				}),
			});
		}
		const kept = items.map(
			(item) => item.kind === "canvas" && item.html !== null,
		);
		expect(kept).toEqual([false, true, true, true, true]);
	});

	it("refuses a document over CANVAS_HTML_LIMIT, an unknown thread and an unknown canvas", async () => {
		const f = fixture({
			"Thread art": read({ html: "x".repeat(CANVAS_HTML_LIMIT + 1) }),
		});
		expect(
			await call(f.tools, "show_canvas", { id: "t1", title: "Thread art" }),
		).toContain("Not shown");
		expect(
			await call(f.tools, "show_canvas", {
				id: "missing",
				title: "Thread art",
			}),
		).toBe("No such thread in this project.");
		expect(
			await call(f.tools, "show_canvas", { id: "t1", title: "Nope" }),
		).toContain('has no canvas titled "Nope"');
		const refused = await modelText(
			f.tools,
			"show_canvas",
			"Not shown: too big",
		);
		expect(refused).toBe("Not shown: too big");
	});

	it("does not show a revision it already shows from that thread again", async () => {
		const shown = applyApiProgress([], "turn", {
			type: "tool-result",
			id: "c1",
			name: "show_canvas",
			output: {
				shown: true,
				title: "Thread art",
				revision: 2,
				html: "<p>x</p>",
				ownerThreadId: "t1",
			},
		});
		const f = fixture({ "Thread art": read() }, shown);
		expect(
			await call(f.tools, "show_canvas", { id: "t1", title: "Thread art" }),
		).toContain("already shown in this chat");
	});
});
