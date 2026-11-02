import { describe, expect, it } from "vitest";
import {
	issueClaudeCodeGrant,
	presentedClaudeCodeGrant,
	verifyClaudeCodeGrant,
} from "./claude-code-grant";

const secret = "s".repeat(40);
const scope = {
	userId: "user-1",
	sessionId: "11111111-1111-4111-8111-111111111111",
	turnId: "22222222-2222-4222-8222-222222222222",
};

describe("Claude Code grants", () => {
	it("round-trips the user, chat and turn it names", async () => {
		const grant = await issueClaudeCodeGrant(secret, scope, 1_000);
		expect(grant).toMatch(/^ytcc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
		expect(await verifyClaudeCodeGrant(secret, grant, 2_000)).toEqual({
			...scope,
			expiresAt: 1_000 + 6 * 60 * 60 * 1000,
		});
	});

	it("refuses an expired, forged or foreign grant", async () => {
		const grant = await issueClaudeCodeGrant(secret, {
			...scope,
			expiresAt: 5_000,
		});
		expect(await verifyClaudeCodeGrant(secret, grant, 5_000)).toBeNull();
		expect(await verifyClaudeCodeGrant("t".repeat(40), grant, 1)).toBeNull();
		const [prefix, body, signature] = grant.split(".");
		const tampered = `${prefix}.${body?.slice(0, -2)}AA.${signature}`;
		expect(await verifyClaudeCodeGrant(secret, tampered, 1)).toBeNull();
		expect(
			await verifyClaudeCodeGrant(secret, "sk-ant-oat01-real", 1),
		).toBeNull();
		expect(await verifyClaudeCodeGrant(secret, null, 1)).toBeNull();
	});

	it("reads the bearer Claude Code sends", () => {
		expect(
			presentedClaudeCodeGrant(new Headers({ authorization: "Bearer abc" })),
		).toBe("abc");
		expect(presentedClaudeCodeGrant(new Headers({ "x-api-key": "k" }))).toBe(
			"k",
		);
		expect(presentedClaudeCodeGrant(new Headers())).toBeNull();
	});
});
