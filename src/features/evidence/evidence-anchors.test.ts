import { describe, expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { EvidenceRecord } from "#/domain/pr-evidence";
import type { SessionItem } from "#/domain/session-item";
import { evidenceAnchors } from "./evidence-anchors";

const user = (id: string, startedAt?: number): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text: id,
	...(startedAt === undefined ? {} : { timing: { startedAt } }),
});
const agent = (id: string): SessionItem => ({
	kind: "agentMessage",
	id: SessionItemId(id),
	text: id,
});
const capture = (id: string, at: number) =>
	({ id, createdAt: new Date(at).toISOString() }) as EvidenceRecord;

describe("evidence cards in the chat", () => {
	it("sit after the turn they were captured for; the latest turn's go last", () => {
		const items = [
			user("u1", 1_000),
			agent("a1"),
			agent("a2"),
			user("u2", 5_000),
			agent("a3"),
		];
		const { anchored, trailing } = evidenceAnchors(items, [
			capture("first", 3_000),
			capture("latest", 6_000),
		]);
		expect(anchored.get("a2")?.map((record) => record.id)).toEqual(["first"]);
		expect(trailing.map((record) => record.id)).toEqual(["latest"]);
	});

	it("go last when no turn has timing", () => {
		const { anchored, trailing } = evidenceAnchors(
			[user("u1"), agent("a1")],
			[capture("x", 1)],
		);
		expect(anchored.size).toBe(0);
		expect(trailing).toHaveLength(1);
	});
});
