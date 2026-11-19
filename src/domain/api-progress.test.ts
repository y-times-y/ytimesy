import { describe, expect, it } from "vitest";
import { applyApiProgress, recordedContextUsage } from "./api-progress";
import { SessionItemId } from "./ids";
import { type SessionItem, sessionItemsFromUnknown } from "./session-item";

it("retains tool inputs and results for inspection", () => {
	const started = applyApiProgress([], "turn", {
		type: "tool-call",
		id: "call",
		name: "bash",
		input: { command: "pnpm test" },
	});
	const completed = applyApiProgress(started, "turn", {
		type: "tool-result",
		id: "call",
		name: "bash",
		output: { stdout: "3 tests passed", exitCode: 0 },
	});
	expect(completed[0]).toMatchObject({
		input: expect.stringContaining("pnpm test"),
		output: expect.stringContaining("3 tests passed"),
	});
});

it("settles a failed tool call instead of leaving its spinner running", () => {
	const started = applyApiProgress([], "turn", {
		type: "tool-call",
		id: "call",
		name: "read_file",
		input: {},
	});
	const settled = applyApiProgress(started, "turn", {
		type: "tool-result",
		id: "call",
		name: "read_file",
		output: null,
		failed: true,
	});
	expect(settled).toEqual([
		{
			kind: "dynamicToolCall",
			id: "turn:call",
			tool: "read_file",
			status: "failed",
			input: "{}",
			output: "null",
		},
	]);
});

it("updates only the current turn and persists current context independently of cumulative usage", () => {
	const items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("old"), text: "old" },
		{ kind: "userMessage", id: SessionItemId("current"), text: "current" },
	];
	let updated = applyApiProgress(items, "turn", {
		type: "context",
		compacting: false,
		context: { last: { totalTokens: 500 }, modelContextWindow: 272000 },
	});
	updated = applyApiProgress(updated, "turn", {
		type: "context",
		compacting: false,
		context: { last: { totalTokens: 100 }, modelContextWindow: 272000 },
	});
	updated = applyApiProgress(updated, "turn", {
		type: "usage",
		usage: {
			inputTokens: 600,
			outputTokens: 20,
			uncachedInputTokens: 600,
			cacheReadTokens: 0,
			cacheWriteTokens: null,
		},
	});
	expect(updated[0]).toEqual(items[0]);
	expect(
		recordedContextUsage(
			sessionItemsFromUnknown(JSON.parse(JSON.stringify(updated))),
		)?.context?.last.totalTokens,
	).toBe(100);
});
it("keeps the last known context during compaction and clears the compacting state", () => {
	let items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("current"), text: "current" },
	];
	items = applyApiProgress(items, "turn", {
		type: "context",
		compacting: false,
		context: { last: { totalTokens: 100 }, modelContextWindow: 1000 },
	});
	items = applyApiProgress(items, "turn", {
		type: "context",
		compacting: true,
	});
	expect(recordedContextUsage(items)?.compacting).toBe(true);
	items = applyApiProgress(items, "turn", {
		type: "context",
		compacting: false,
	});
	expect(recordedContextUsage(items)?.compacting).toBe(false);
	expect(recordedContextUsage(items)?.context?.last.totalTokens).toBe(100);
});

it("keeps replace on a secret request, so the card can say it replaces a value", () => {
	const items = applyApiProgress([], "turn", {
		type: "tool-result",
		id: "call",
		name: "request_project_secret",
		output: {
			requested: true,
			secrets: [
				{
					name: "CLOUDFLARE_DEPLOY_TOKEN",
					kind: "runtime",
					reason: "Rejected",
					replace: true,
				},
				{ name: "STRIPE_KEY", kind: "runtime", reason: "" },
			],
		},
	});
	expect(items[0]).toMatchObject({
		kind: "secretRequest",
		secrets: [
			{
				name: "CLOUDFLARE_DEPLOY_TOKEN",
				secretKind: "runtime",
				replace: true,
			},
			{ name: "STRIPE_KEY", secretKind: "runtime" },
		],
	});
	const request = items[0];
	const second =
		request?.kind === "secretRequest" && "secrets" in request
			? request.secrets[1]
			: undefined;
	expect(second?.replace).toBeUndefined();
});

describe("a viewed image's tool result", () => {
	it("keeps only what the image is in the card and the transcript, never its base64", () => {
		const items = applyApiProgress([], "turn", {
			type: "tool-result",
			id: "c1",
			name: "view_image",
			failed: false,
			output: {
				name: "screenshot.png",
				size: 84_000,
				mediaType: "image/png",
				base64: "A".repeat(112_000),
			},
		});
		const output = (items[0] as { output?: string }).output ?? "";
		expect(output).toContain("screenshot.png");
		expect(output).toContain("not stored");
		expect(output).not.toContain("AAAAAAAA");
		expect(output.length).toBeLessThan(400);
	});
});
