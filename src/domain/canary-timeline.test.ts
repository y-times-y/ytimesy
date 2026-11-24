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
	const late = { ...input, elapsedMs: 9 * 60_000 };
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
