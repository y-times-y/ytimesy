import { describe, expect, it } from "vitest";
import {
	backgroundExitRequest,
	backgroundExitToken,
	verifyBackgroundExitToken,
} from "./background-exit-wake";

const secret = "s".repeat(40);
const request = {
	userId: "user",
	sessionId: crypto.randomUUID(),
	commandId: crypto.randomUUID(),
};

describe("background command exit callback token", () => {
	it("verifies only for the command, chat, user and key it was made for", async () => {
		const token = await backgroundExitToken(secret, request);
		expect(await verifyBackgroundExitToken(secret, request, token)).toBe(true);
		for (const other of [
			{ ...request, commandId: crypto.randomUUID() },
			{ ...request, sessionId: crypto.randomUUID() },
			{ ...request, userId: "someone-else" },
		])
			expect(await verifyBackgroundExitToken(secret, other, token)).toBe(false);
		expect(
			await verifyBackgroundExitToken("t".repeat(40), request, token),
		).toBe(false);
		expect(await verifyBackgroundExitToken(secret, request, "")).toBe(false);
		expect(
			await verifyBackgroundExitToken(secret, request, token.toUpperCase()),
		).toBe(false);
	});

	it("accepts only a bounded, exact request body", () => {
		expect(backgroundExitRequest.safeParse(request).success).toBe(true);
		expect(
			backgroundExitRequest.safeParse({ ...request, extra: 1 }).success,
		).toBe(false);
		expect(
			backgroundExitRequest.safeParse({ ...request, commandId: "x" }).success,
		).toBe(false);
	});
});
