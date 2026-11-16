import { describe, expect, it } from "vitest";
import {
	addLivePreviews,
	claudeFeedPreview,
	LIVE_PREVIEW_MAX_CHARS,
	type LivePreviews,
	livePreviewFrame,
	parseLivePreview,
	pendingLivePreviews,
	withLivePreviews,
} from "./claude-feed-preview";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

const TURN = "22222222-2222-4222-8222-222222222222";
const line = (value: unknown) => JSON.stringify(value);
const assistant = (...content: unknown[]) =>
	line({ type: "assistant", message: { content } });

describe("the object's preview of stored feed lines", () => {
	it("maps text and reasoning with the step's ids, redacted", () => {
		const preview = claudeFeedPreview(
			TURN,
			[
				[0, line({ type: "system", subtype: "init" })],
				[
					40,
					assistant(
						{ type: "thinking", thinking: "Looking at hunter2 first." },
						{ type: "text", text: "The token is hunter2." },
					),
				],
			],
			["hunter2"],
		);
		expect(preview).toEqual({
			type: "preview",
			turnId: TURN,
			events: [
				{
					type: "reasoning-delta",
					id: "cc-40-0",
					text: expect.not.stringContaining("hunter2"),
				},
				{ type: "reasoning-end", id: "cc-40-0", durationSeconds: 0 },
				{
					type: "text-delta",
					id: "cc-40-1",
					text: expect.not.stringContaining("hunter2"),
				},
			],
		});
	});

	it("leaves tool calls, tool results and the result to the step", () => {
		const preview = claudeFeedPreview(
			TURN,
			[
				[
					0,
					assistant({
						type: "tool_use",
						id: "toolu_1",
						name: "Bash",
						input: { command: "ls" },
					}),
				],
				[
					90,
					line({
						type: "user",
						message: {
							content: [
								{ type: "tool_result", tool_use_id: "toolu_1", content: "a" },
							],
						},
					}),
				],
				[160, line({ type: "result", subtype: "success", result: "done" })],
			],
			[],
		);
		expect(preview.events).toEqual([]);
	});

	it("sends no frame larger than the cap", () => {
		const small = claudeFeedPreview(
			TURN,
			[[0, assistant({ type: "text", text: "hi" })]],
			[],
		);
		expect(JSON.parse(livePreviewFrame(small) ?? "")).toEqual(small);
		const large = claudeFeedPreview(
			TURN,
			[
				[
					0,
					assistant({ type: "text", text: "x".repeat(LIVE_PREVIEW_MAX_CHARS) }),
				],
			],
			[],
		);
		expect(livePreviewFrame(large)).toBeNull();
	});
});

describe("a preview frame on the page", () => {
	it("reads only preview frames and drops malformed events", () => {
		expect(parseLivePreview({ revision: "3", delta: {} })).toBeNull();
		expect(parseLivePreview({ type: "preview", events: [] })).toBeNull();
		expect(
			parseLivePreview({
				type: "preview",
				turnId: TURN,
				events: [
					{ type: "text-delta", id: "cc-0-0", text: "hi" },
					{ type: "text-delta", id: "", text: "no id" },
					{ type: "tool-call", id: "toolu_1", name: "Bash" },
					{ type: "reasoning-end", id: "cc-0-1", durationSeconds: 0 },
				],
			}),
		).toEqual({
			type: "preview",
			turnId: TURN,
			events: [
				{ type: "text-delta", id: "cc-0-0", text: "hi" },
				{ type: "reasoning-end", id: "cc-0-1", durationSeconds: 0 },
			],
		});
	});

	const user: SessionItem = {
		kind: "userMessage",
		id: SessionItemId("u1"),
		text: "Fix it.",
	} as SessionItem;
	const frame = (...events: { id: string; text: string }[]) => ({
		type: "preview" as const,
		turnId: TURN,
		events: events.map((event) => ({ type: "text-delta" as const, ...event })),
	});

	it("shows previewed text after the published items, once per event", () => {
		let previews: LivePreviews = [];
		previews = addLivePreviews(
			previews,
			frame({ id: "cc-10-0", text: "Working on it." }),
		);
		const again = addLivePreviews(
			previews,
			frame({ id: "cc-10-0", text: "Working on it." }),
		);
		expect(again).toBe(previews);
		expect(withLivePreviews([user], previews)).toEqual([
			user,
			{
				kind: "agentMessage",
				id: `${TURN}:cc-10-0`,
				text: "Working on it.",
				streaming: true,
			},
		]);
	});

	it("gives way to the step's published item, never showing it twice", () => {
		const previews = addLivePreviews(
			[],
			frame(
				{ id: "cc-10-0", text: "Working on it." },
				{ id: "cc-90-0", text: "Done soon." },
			),
		);
		// The step published the first line's item (redacted, authoritative).
		const published: SessionItem[] = [
			user,
			{
				kind: "agentMessage",
				id: SessionItemId(`${TURN}:cc-10-0`),
				text: "Working on it.",
				streaming: true,
			} as SessionItem,
		];
		const pending = pendingLivePreviews(published, previews);
		expect(pending.map(({ event }) => event.id)).toEqual(["cc-90-0"]);
		const shown = withLivePreviews(published, pending);
		expect(shown.map((item) => item.id)).toEqual([
			"u1",
			`${TURN}:cc-10-0`,
			`${TURN}:cc-90-0`,
		]);
		expect(shown.filter((item) => item.id === `${TURN}:cc-10-0`)).toHaveLength(
			1,
		);
		// Once all are published, nothing is previewed.
		expect(
			pendingLivePreviews(withLivePreviews(published, pending), previews),
		).toEqual([]);
	});
});
