import { expect, it, vi } from "vitest";
import type {
	SessionReadDelta,
	SessionReadFull,
	SessionRowFields,
} from "#/domain/session-delta";
import type { SessionItem } from "#/domain/session-item";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	createSessionDeltaReader,
	WHOLE_READ_EVERY_MS,
} from "./session-delta-reader";

const selection = {
	projectId: "p",
	sessionId: "s",
	harnessId: "api" as const,
};

const message = (id: string, text = id): SessionItem =>
	({ kind: "agentMessage", id, text }) as SessionItem;

function view(
	items: SessionItem[],
	turnStatus: PublicCodexSession["turnStatus"] = "running",
): PublicCodexSession {
	return {
		snapshotAvailable: false,
		workspaceId: "w",
		agentSessionId: "s",
		connection: { status: "disconnected" },
		models: [],
		listedModelId: "m",
		blockedListedModelIds: [],
		canSend: true,
		turnStatus,
		items,
	};
}

const row = (turnStatus: SessionRowFields["turnStatus"]): SessionRowFields => ({
	turnStatus,
	workspaceId: "w",
	selectedBranch: null,
	listedModelId: "m",
});

const whole = (
	items: SessionItem[],
	rev: number,
	turnStatus: PublicCodexSession["turnStatus"] = "running",
): SessionReadFull<PublicCodexSession> => ({
	mode: "full",
	view: view(items, turnStatus),
	token: { rev, count: items.length },
	queuedCount: 0,
});

it("reads whole first, then asks for what changed since, and merges the tail", async () => {
	const first = [message("a"), message("b")];
	const read = vi
		.fn()
		.mockResolvedValueOnce(whole(first, 1))
		.mockResolvedValueOnce({
			mode: "delta",
			token: { rev: 2, count: 3 },
			row: row("running"),
			change: { anchorId: "a", tail: [message("b", "b grown"), message("c")] },
			queued: [],
		} satisfies SessionReadDelta);
	const reader = createSessionDeltaReader({ read, now: () => 0 });
	const opened = await reader.read(selection);
	expect(opened.items).toHaveLength(2);
	const next = await reader.read(selection);
	expect(next.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
	expect(read).toHaveBeenLastCalledWith({
		...selection,
		since: { rev: 1, count: 2 },
	});
	// The view's fields the delta does not carry stay as the last whole read had them.
	expect(next.canSend).toBe(true);
});

it("an unchanged chat returns the held view itself", async () => {
	const read = vi
		.fn()
		.mockResolvedValueOnce(whole([message("a")], 1))
		.mockResolvedValueOnce({
			mode: "delta",
			token: { rev: 1, count: 1 },
			row: row("running"),
			change: null,
			queued: [],
		} satisfies SessionReadDelta);
	const reader = createSessionDeltaReader({ read, now: () => 0 });
	const opened = await reader.read(selection);
	const next = await reader.read(selection);
	expect(next.items).toBe(opened.items);
});

it("reads whole when the tail has no anchor or the delta fails", async () => {
	const base = [message("a"), message("b")];
	const lost: SessionReadDelta = {
		mode: "delta",
		token: { rev: 2, count: 2 },
		queued: [],
		row: row("running"),
		change: { anchorId: "gone", tail: [message("c")] },
	};
	for (const second of [lost, new Error("down")]) {
		const read = vi
			.fn()
			.mockResolvedValueOnce(whole(base, 1))
			.mockImplementationOnce(() =>
				second instanceof Error
					? Promise.reject(second)
					: Promise.resolve(second),
			)
			.mockResolvedValueOnce(whole([...base, message("z")], 3, "completed"));
		const reader = createSessionDeltaReader({ read, now: () => 0 });
		await reader.read(selection);
		const next = await reader.read(selection);
		expect(next.items.map((item) => item.id)).toEqual(["a", "b", "z"]);
		expect(read).toHaveBeenCalledTimes(3);
		expect(read).toHaveBeenLastCalledWith(selection);
	}
});

it("refreshes the view's other fields beside the delta once they are older than the interval, keeping the held transcript", async () => {
	let now = 0;
	const read = vi
		.fn()
		.mockResolvedValueOnce({
			...whole([message("a")], 1),
			view: { ...view([message("a")]), sendBlockers: ["github"] },
		})
		.mockResolvedValueOnce({
			mode: "delta",
			token: { rev: 2, count: 2 },
			row: row("running"),
			change: { anchorId: "a", tail: [message("b")] },
			queued: [],
			fields: {
				snapshotAvailable: false,
				connection: { status: "expired", provider: "codex", message: "x" },
				models: [],
				blockedListedModelIds: [],
				canSend: false,
			},
		} satisfies SessionReadDelta)
		.mockResolvedValueOnce({
			mode: "delta",
			token: { rev: 2, count: 2 },
			row: row("running"),
			change: null,
			queued: [],
		} satisfies SessionReadDelta);
	const reader = createSessionDeltaReader({ read, now: () => now });
	await reader.read(selection);
	now = WHOLE_READ_EVERY_MS + 1;
	const next = await reader.read(selection);
	expect(read).toHaveBeenLastCalledWith({
		...selection,
		since: { rev: 1, count: 1 },
		fields: true,
	});
	expect(next.items.map((item) => item.id)).toEqual(["a", "b"]);
	expect(next.connection.status).toBe("expired");
	expect(next.canSend).toBe(false);
	// A field the fresh read no longer has is gone.
	expect(next.sendBlockers).toBeUndefined();
	// The fields are fresh now: the next poll does not ask again.
	await reader.read(selection);
	expect(read).toHaveBeenCalledTimes(3);
	expect(read.mock.calls[2]?.[0]).not.toHaveProperty("fields");
});

it("keeps the waiting messages apart from the transcript", async () => {
	const waiting = {
		kind: "userMessage",
		id: "q1",
		text: "next",
	} as SessionItem;
	const read = vi
		.fn()
		.mockResolvedValueOnce({
			...whole([message("a"), { ...waiting, queued: true } as SessionItem], 1),
			queuedCount: 1,
		})
		.mockResolvedValueOnce({
			mode: "delta",
			token: { rev: 2, count: 2 },
			row: row("running"),
			change: { anchorId: "a", tail: [message("b")] },
			queued: [waiting as never],
		} satisfies SessionReadDelta);
	const reader = createSessionDeltaReader({ read, now: () => 0 });
	await reader.read(selection);
	const next = await reader.read(selection);
	expect(next.items.map((item) => item.id)).toEqual(["a", "b", "q1"]);
});

it("a read ahead is used when nothing is held, and carries no token", async () => {
	const read = vi.fn().mockResolvedValue(whole([message("a")], 1));
	const reader = createSessionDeltaReader({ read, now: () => 0 });
	const ahead = view([message("x")]);
	const first = await reader.read(selection, async () => ahead);
	expect(first).toBe(ahead);
	expect(read).not.toHaveBeenCalled();
});

it("a turn that changed status is settled by a fields-only delta, not a whole read", async () => {
	const base = [message("a"), message("b")];
	const read = vi
		.fn()
		.mockResolvedValueOnce(whole(base, 1))
		.mockResolvedValueOnce({
			mode: "delta",
			token: { rev: 2, count: 3 },
			row: row("completed"),
			change: { anchorId: "b", tail: [message("c")] },
			queued: [],
		} satisfies SessionReadDelta)
		.mockResolvedValueOnce({
			mode: "delta",
			token: { rev: 2, count: 3 },
			row: row("completed"),
			change: null,
			queued: [],
			fields: { canSend: false },
		} satisfies SessionReadDelta);
	const reader = createSessionDeltaReader({ read, now: () => 0 });
	await reader.read(selection);
	const next = await reader.read(selection);
	expect(next.turnStatus).toBe("completed");
	expect(next.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
	expect(next.canSend).toBe(false);
	expect(read).toHaveBeenCalledTimes(3);
	expect(read).toHaveBeenLastCalledWith({
		...selection,
		since: { rev: 2, count: 3 },
		fields: true,
	});
});

it("two reads of one chat in the same tick make one request", async () => {
	let finish: (value: SessionReadFull<PublicCodexSession>) => void = () => {};
	const read = vi.fn().mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const reader = createSessionDeltaReader({ read, now: () => 0 });
	const first = reader.read(selection);
	const second = reader.read(selection);
	await new Promise((resolve) => setTimeout(resolve, 0));
	finish(whole([message("a")], 1));
	expect(await first).toBe(await second);
	expect(read).toHaveBeenCalledTimes(1);
	// Once settled, the next read is a new request (a delta over what is held).
	read.mockResolvedValueOnce({
		mode: "delta",
		token: { rev: 1, count: 1 },
		row: row("running"),
		change: null,
		queued: [],
	} satisfies SessionReadDelta);
	await reader.read(selection);
	expect(read).toHaveBeenCalledTimes(2);
});
