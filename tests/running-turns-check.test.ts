import { expect, it } from "vitest";
import { runningTurnsDecision } from "../scripts/running-turns-check";

const chat = (n: number) =>
	`${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`;

it("proceeds when no chat is running a turn", () => {
	expect(runningTurnsDecision({ kind: "counted", chatIds: [] })).toEqual({
		proceed: true,
		message: "No chat is running a turn.",
	});
});

it("reports running turns without blocking, naming chats by shortened id only", () => {
	const decision = runningTurnsDecision({
		kind: "counted",
		chatIds: [chat(1), chat(2)],
	});
	expect(decision.proceed).toBe(true);
	expect(decision.message).toContain(
		"2 chats are running a turn (00000001, 00000002)",
	);
	expect(decision.message).not.toContain("aaaa");
});

it("counts a chat once and caps the listed ids", () => {
	const ids = Array.from({ length: 13 }, (_, n) => chat(n));
	const decision = runningTurnsDecision({
		kind: "counted",
		chatIds: [...ids, chat(0)],
	});
	expect(decision.message).toContain("13 chats");
	expect(decision.message).toContain("+3 more");
});

it("still refuses when the count cannot be read", () => {
	const decision = runningTurnsDecision({
		kind: "unreadable",
		reason: "Error",
	});
	expect(decision.proceed).toBe(false);
	expect(decision.message).toContain("Refusing to deploy");
});
