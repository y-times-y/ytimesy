import { describe, expect, it } from "vitest";
import {
	generateTurnBoxKeyPair,
	issueTurnBoxGrant,
	issueTurnBoxIdentity,
	TURN_BOX_GRANT_TTL_MS,
	TurnBoxReplayGuard,
	verifyTurnBoxGrant,
	verifyTurnBoxIdentity,
} from "./turn-box-grant";

const scope = {
	userId: "user-1",
	sessionId: "11111111-1111-4111-8111-111111111111",
	turnId: "22222222-2222-4222-8222-222222222222",
	leaseId: "33333333-3333-4333-8333-333333333333",
	boxId: "box-a",
};

describe("turn box grants", () => {
	it("round-trips the turn, lease and box it names, valid for 10 minutes", async () => {
		const keys = await generateTurnBoxKeyPair();
		const grant = await issueTurnBoxGrant(keys.privateKey, scope, 1_000);
		expect(grant).toMatch(/^ytbg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
		const verified = await verifyTurnBoxGrant(keys.publicKey, grant, 2_000);
		expect(verified).toMatchObject({
			...scope,
			expiresAt: 1_000 + TURN_BOX_GRANT_TTL_MS,
		});
		expect(TURN_BOX_GRANT_TTL_MS).toBe(600_000);
	});

	it("refuses an expired, forged, tampered or foreign-key grant", async () => {
		const keys = await generateTurnBoxKeyPair();
		const other = await generateTurnBoxKeyPair();
		const grant = await issueTurnBoxGrant(keys.privateKey, scope, 1_000);
		const expiry = 1_000 + TURN_BOX_GRANT_TTL_MS;
		expect(await verifyTurnBoxGrant(keys.publicKey, grant, expiry)).toBeNull();
		expect(await verifyTurnBoxGrant(other.publicKey, grant, 2_000)).toBeNull();
		const [prefix, body, signature] = grant.split(".") as [
			string,
			string,
			string,
		];
		const forged = btoa(
			JSON.stringify({
				...JSON.parse(atob(body.replaceAll("-", "+").replaceAll("_", "/"))),
				u: "victim",
			}),
		)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		expect(
			await verifyTurnBoxGrant(
				keys.publicKey,
				`${prefix}.${forged}.${signature}`,
				2_000,
			),
		).toBeNull();
		expect(
			await verifyTurnBoxGrant(keys.publicKey, "ytbg1.a.b", 2_000),
		).toBeNull();
		expect(await verifyTurnBoxGrant(keys.publicKey, null, 2_000)).toBeNull();
		expect(
			await verifyTurnBoxGrant(keys.publicKey, "x".repeat(2000), 2_000),
		).toBeNull();
	});

	it("never lets an identity verify as a grant or the reverse", async () => {
		const keys = await generateTurnBoxKeyPair();
		const identity = await issueTurnBoxIdentity(
			keys.privateKey,
			{ boxId: "box-a" },
			1_000,
		);
		const grant = await issueTurnBoxGrant(keys.privateKey, scope, 1_000);
		expect(
			await verifyTurnBoxGrant(keys.publicKey, identity, 2_000),
		).toBeNull();
		expect(
			await verifyTurnBoxIdentity(keys.publicKey, grant, 2_000),
		).toBeNull();
		expect(
			await verifyTurnBoxIdentity(keys.publicKey, identity, 2_000),
		).toMatchObject({
			boxId: "box-a",
		});
		// Re-prefixing a grant's payload and signature does not pass either.
		const swapped = `ytbi1.${grant.split(".").slice(1).join(".")}`;
		expect(
			await verifyTurnBoxIdentity(keys.publicKey, swapped, 2_000),
		).toBeNull();
	});

	it("rejects a malformed grant request at issue time", async () => {
		const keys = await generateTurnBoxKeyPair();
		await expect(
			issueTurnBoxGrant(keys.privateKey, { ...scope, turnId: "not-a-uuid" }),
		).rejects.toThrow();
	});

	it("replay guard accepts a nonce once, until it expires", () => {
		const guard = new TurnBoxReplayGuard();
		expect(guard.consume("n1", 5_000, 1_000)).toBe(true);
		expect(guard.consume("n1", 5_000, 2_000)).toBe(false);
		expect(guard.consume("n1", 9_000, 5_000)).toBe(true);
	});

	it("a full replay guard refuses rather than forgetting", () => {
		const guard = new TurnBoxReplayGuard(2);
		expect(guard.consume("a", 9_000, 1)).toBe(true);
		expect(guard.consume("b", 9_000, 1)).toBe(true);
		expect(guard.consume("c", 9_000, 1)).toBe(false);
	});
});
