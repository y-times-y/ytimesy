import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { CANVAS_HTML_LIMIT } from "#/domain/canvas";
import { WorkspaceId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { canvasTools } from "./canvas-tool";
import { withRedactedResults } from "./redacted-tools";
import type { WorkspaceMachines } from "./workspace-machines";

const options = {
	toolCallId: "c",
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
};

function setup(
	items: SessionItem[] = [],
	files: Record<string, string> = {},
	savedRevision?: (title: string) => Promise<number>,
) {
	const readTextFile = vi.fn(
		async (_vm: unknown, path: string) => files[path] ?? null,
	);
	const workspace: AgentToolWorkspace = {
		machines: { readTextFile } as unknown as WorkspaceMachines,
		vm: WorkspaceId("vm"),
		cwd: "/home/user/repo",
	};
	const tools = canvasTools({
		items: () => items,
		workspace: async () => workspace,
		...(savedRevision ? { savedRevision } : {}),
	});
	const run = (tool: ToolSet[string], input: object) =>
		(tool.execute as NonNullable<typeof tool.execute>)(input, options);
	return {
		tools,
		readTextFile,
		run: (input: object) => run(tools.canvas, input),
	};
}

describe("canvas tool", () => {
	it("numbers from the chat's saved revisions, not only this turn's items", async () => {
		// A modern turn holds only its own items; earlier turns' canvases are saved.
		const { run } = setup([], {}, async (title) =>
			title === "Pricing page" ? 2 : 0,
		);
		const next = await run({ title: "Pricing page", html: "<h1>3</h1>" });
		expect(next).toMatchObject({ title: "Pricing page", revision: 3 });
		const fresh = await run({ title: "Other", html: "<h1>1</h1>" });
		expect(fresh).toMatchObject({ title: "Other", revision: 1 });
	});

	it("shows an html document as revision 1 and tells the model only that", async () => {
		const { tools, run } = setup();
		const output = await run({ title: "Pricing page", html: "<h1>Plans</h1>" });
		expect(output).toEqual({
			shown: true,
			title: "Pricing page",
			revision: 1,
			html: "<h1>Plans</h1>",
		});
		const toModel = await tools.canvas.toModelOutput?.({
			toolCallId: "c",
			input: {},
			output,
		});
		expect(toModel).toEqual({
			type: "text",
			value:
				"Shown to the user as canvas 'Pricing page' (revision 1), 0 KB: a card in this chat that opens in the Canvas panel beside it, where they preview it and pin notes.",
		});
	});

	it("needs exactly one of html or path, and a title", async () => {
		const { run } = setup();
		await expect(run({ title: "A" })).rejects.toThrow("exactly one");
		await expect(
			run({ title: "A", html: "<p/>", path: "a.html" }),
		).rejects.toThrow("exactly one");
		await expect(run({ title: "   ", html: "<p/>" })).rejects.toThrow("title");
		await expect(run({ title: "A", html: "  " })).rejects.toThrow("empty");
	});

	it("declares its limits in the input schema", async () => {
		const { tools } = setup();
		const schema = tools.canvas.inputSchema as {
			safeParse: (value: unknown) => { success: boolean };
		};
		expect(
			schema.safeParse({ title: "x".repeat(61), html: "<p/>" }).success,
		).toBe(false);
		expect(schema.safeParse({ title: "Ok", html: "<p/>" }).success).toBe(true);
	});

	it("refuses a document over the size limit", async () => {
		const { run } = setup();
		await expect(
			run({ title: "Huge", html: "x".repeat(CANVAS_HTML_LIMIT + 1) }),
		).rejects.toThrow("at most");
	});

	it("adds a revision for the same title, counting calls in flight", async () => {
		const items: SessionItem[] = [
			{
				kind: "canvas",
				id: "t:1" as SessionItem["id"],
				title: "Dashboard",
				revision: 2,
				html: "<p/>",
			},
		];
		const { run } = setup(items);
		const [a, b] = await Promise.all([
			run({ title: "Dashboard", html: "<p>a</p>" }),
			run({ title: " Dashboard ", html: "<p>b</p>" }),
		]);
		expect(
			[a, b].map((output) => (output as { revision: number }).revision),
		).toEqual([3, 4]);
		const other = await run({ title: "Other", html: "<p/>" });
		expect((other as { revision: number }).revision).toBe(1);
	});

	it("reads a workspace .html file by a relative or absolute path", async () => {
		const { run, readTextFile } = setup([], {
			"/home/user/repo/dist/index.html": "<h1>Built</h1>",
			"/tmp/mock.html": "<h1>Mock</h1>",
		});
		expect(await run({ title: "Built", path: "dist/index.html" })).toEqual({
			shown: true,
			title: "Built",
			revision: 1,
			html: "<h1>Built</h1>",
			path: "dist/index.html",
		});
		expect(readTextFile).toHaveBeenCalledWith(
			"vm",
			"/home/user/repo/dist/index.html",
		);
		expect(await run({ title: "Mock", path: "/tmp/mock.html" })).toMatchObject({
			path: "/tmp/mock.html",
		});
		await expect(run({ title: "Env", path: ".env" })).rejects.toThrow(
			".html file",
		);
		await expect(run({ title: "Gone", path: "nope.html" })).rejects.toThrow(
			"No file",
		);
	});

	it("redacts credential-shaped values and the project's secrets", async () => {
		const { tools } = setup();
		const wrapped = withRedactedResults(tools, ["project-secret-value-123"]);
		const output = (await (
			wrapped.canvas.execute as NonNullable<typeof wrapped.canvas.execute>
		)(
			{
				title: "Config",
				html: `<pre>token ghp_abcdefghijklmnop key sk-abcdefghijklmnopqrst db project-secret-value-123</pre>`,
			},
			options,
		)) as { html: string };
		expect(output.html).not.toContain("ghp_abcdefghijklmnop");
		expect(output.html).not.toContain("sk-abcdefghijklmnopqrst");
		expect(output.html).not.toContain("project-secret-value-123");
		expect(output.html).toContain("[redacted]");
	});
});
