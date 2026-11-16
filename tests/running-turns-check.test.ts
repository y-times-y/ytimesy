import { expect, it, vi } from "vitest";
import {
	type RunningTurnsCheck,
	runningTurnsDecision,
	waitForClaudeTurns,
} from "../scripts/running-turns-check";

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

const counted = (...claude: number[]): RunningTurnsCheck => ({
	kind: "counted",
	chatIds: [chat(1), ...claude.map(chat)],
	claudeChatIds: claude.map(chat),
});

it("does not wait when no Claude turn is running, even if another turn is", async () => {
	const sleep = vi.fn(async () => {});
	const result = await waitForClaudeTurns(async () => counted(), {
		sleep,
		log: () => {},
	});
	expect(result).toEqual({ waitedMs: 0, remaining: [] });
	expect(sleep).not.toHaveBeenCalled();
});

it("waits until the Claude turns finish", async () => {
	const reads = [counted(2, 3), counted(3), counted()];
	const sleep = vi.fn(async () => {});
	const log = vi.fn();
	const result = await waitForClaudeTurns(
		async () => reads.shift() ?? counted(),
		{
			pollMs: 1_000,
			sleep,
			log,
		},
	);
	expect(result).toEqual({ waitedMs: 2_000, remaining: [] });
	expect(sleep).toHaveBeenCalledTimes(2);
	expect(log.mock.calls[0][0]).toContain("2 Claude turns");
	expect(log.mock.calls[0][0]).not.toContain("aaaa");
});

it("gives up after the time limit and names the chats still running", async () => {
	const result = await waitForClaudeTurns(async () => counted(5), {
		timeoutMs: 3_000,
		pollMs: 1_000,
		sleep: async () => {},
		log: () => {},
	});
	expect(result).toEqual({ waitedMs: 3_000, remaining: ["00000005"] });
});

it("stops waiting when the count cannot be read", async () => {
	const result = await waitForClaudeTurns(
		async () => ({ kind: "unreadable", reason: "Error" }),
		{ sleep: async () => {}, log: () => {} },
	);
	expect(result).toEqual({ waitedMs: 0, remaining: [] });
});
