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

it("reads whole when the turn changed status, the tail has no anchor, or the delta fails", async () => {
	const base = [message("a"), message("b")];
	const ended: SessionReadDelta = {
		mode: "delta",
		token: { rev: 2, count: 2 },
		row: row("completed"),
		change: null,
		queued: [],
	};
	const lost: SessionReadDelta = {
		...ended,
		row: row("running"),
		change: { anchorId: "gone", tail: [message("c")] },
	};
	for (const second of [ended, lost, new Error("down")]) {
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

it("reads whole again once the held view is older than the whole-read interval", async () => {
	let now = 0;
	const read = vi
		.fn()
		.mockResolvedValueOnce(whole([message("a")], 1))
		.mockResolvedValueOnce(whole([message("a"), message("b")], 2));
	const reader = createSessionDeltaReader({ read, now: () => now });
	await reader.read(selection);
	now = WHOLE_READ_EVERY_MS + 1;
	const next = await reader.read(selection);
	expect(next.items).toHaveLength(2);
	expect(read).toHaveBeenLastCalledWith(selection);
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
