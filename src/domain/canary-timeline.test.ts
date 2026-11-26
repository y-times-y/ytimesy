import { expect, it } from "vitest";
import { canaryPrompts, canaryVerdict } from "./canary-timeline";
import type { SessionItem } from "./session-item";

const nonce = "n1";
const p = canaryPrompts(nonce);
const user = (id: string, text: string) =>
	({ kind: "userMessage", id, text }) as SessionItem;
const agent = (id: string, text: string) =>
	({ kind: "agentMessage", id, text }) as SessionItem;
const error = (message: string) =>
	({ kind: "error", id: "e", message }) as SessionItem;
const [old, a, ra, b, rb] = [
	user("old", "earlier"),
	user("a", p.first),
	agent("ra", "PONG-A-n1"),
	user("b", p.second),
	agent("rb", "PONG-B-n1"),
];
const input = { nonce, baselineItems: 1, elapsedMs: 60_000 };

it("passes a healthy timeline, queued message before or after the first answer", () => {
	expect(canaryVerdict([old, a, ra, b, rb], input).status).toBe("pass");
	expect(canaryVerdict([old, a, b, ra, rb], input).status).toBe("pass");
});

it("fails at once on an error item, but not on one from before the run", () => {
	expect(
		canaryVerdict([old, a, error("The worker disconnected."), b], input),
	).toMatchObject({
		status: "fail",
		reason: expect.stringContaining("error item"),
	});
	expect(canaryVerdict([error("old"), a, ra, b, rb], input).status).toBe(
		"pass",
	);
});

it("waits while answers are missing, then fails with the first missing piece", () => {
	expect(canaryVerdict([old, a, ra, b], input).status).toBe("pending");
	const late = { ...input, elapsedMs: 14 * 60_000 };
	expect(canaryVerdict([old, a, ra, b], late)).toMatchObject({
		status: "fail",
		reason: expect.stringContaining("second message was not answered"),
	});
	expect(canaryVerdict([old, a, b], late)).toMatchObject({
		reason: expect.stringContaining("first message was not answered"),
	});
	expect(canaryVerdict([old, a, ra], late)).toMatchObject({
		reason: expect.stringContaining("second message is missing"),
	});
	expect(canaryVerdict([old], late)).toMatchObject({
		reason: expect.stringContaining("first message is missing"),
	});
});

it("fails when the answers arrive out of order", () => {
	expect(canaryVerdict([old, a, b, rb, ra], input)).toMatchObject({
		status: "fail",
		reason: "the timeline is out of order",
	});
});

it("finds its messages by nonce even when the baseline overshoots the chat", () => {
	// Items before the run were compacted or trimmed, or manual messages shifted
	// the count: the nonce is unique, so the position must not matter.
	expect(
		canaryVerdict([a, ra, b, rb], { ...input, baselineItems: 9 }).status,
	).toBe("pass");
});

it("ignores other canary-looking messages typed into the chat by hand", () => {
	const manual = user("m", "Canary check. Reply with exactly: PONG-A-other");
	const manualReply = agent("mr", "PONG-A-other");
	expect(
		canaryVerdict([manual, manualReply, a, ra, b, rb], {
			...input,
			baselineItems: 0,
		}).status,
	).toBe("pass");
});

it("rechecks once after the latency bound before failing on a missing piece", () => {
	const justPast = { ...input, elapsedMs: 9 * 60_000 };
	expect(canaryVerdict([old], justPast).status).toBe("pending");
	expect(
		canaryVerdict([old, a, error("The worker disconnected.")], justPast).status,
	).toBe("fail");
});

it("finds its messages among hand-typed ones that shift every position", () => {
	const typed = [user("t1", "hello?"), agent("t2", "Hi!"), user("t3", "pong")];
	expect(
		canaryVerdict([old, ...typed, a, ...typed, ra, b, rb], input).status,
	).toBe("pass");
});

it("keeps waiting through the re-check window, then fails at the bound plus one tick", () => {
	const missingAnswer = [old, a, ra, b];
	const at = (minutes: number) => ({ ...input, elapsedMs: minutes * 60_000 });
	expect(canaryVerdict(missingAnswer, at(8)).status).toBe("pending");
	expect(canaryVerdict(missingAnswer, at(12.9)).status).toBe("pending");
	expect(canaryVerdict(missingAnswer, at(13))).toMatchObject({
		status: "fail",
		reason: expect.stringContaining("second message was not answered"),
	});
});

it("passes a run a deploy delayed past the bound but not past the re-check", () => {
	// A deploy mid-run restarts the turn: the second answer lands at the tick
	// after the 8-minute bound, which must pass instead of alerting.
	expect(
		canaryVerdict([old, a, ra, b, rb], { ...input, elapsedMs: 10 * 60_000 })
			.status,
	).toBe("pass");
});

it("still fails at once on an error item inside the re-check window", () => {
	expect(
		canaryVerdict([old, a, error("The worker disconnected.")], {
			...input,
			elapsedMs: 10 * 60_000,
		}).status,
	).toBe("fail");
});
