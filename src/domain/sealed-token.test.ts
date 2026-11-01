import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import {
	isVersionedSeal,
	openVersioned,
	openVersionedBytes,
	sealVersioned,
	sealVersionedBytes,
	vaultKeys,
} from "./sealed-token";

const secret = "a".repeat(40);
const keys = vaultKeys({ BETTER_AUTH_SECRET: secret });
const bound = { purpose: "github-credentials", userId: "user-1" };

describe("sealed tokens", () => {
	it("round-trips with a key id and binding", () => {
		const sealed = sealVersioned(keys, "token", bound);
		expect(sealed.startsWith("v2.k0.")).toBe(true);
		expect(isVersionedSeal(sealed)).toBe(true);
		expect(openVersioned(keys, sealed, bound)).toBe("token");
	});

	it("rejects a blob opened for another user or purpose", () => {
		const sealed = sealVersioned(keys, "token", bound);
		expect(() =>
			openVersioned(keys, sealed, { ...bound, userId: "user-2" }),
		).toThrow();
		expect(() =>
			openVersioned(keys, sealed, { ...bound, purpose: "mcp-oauth" }),
		).toThrow();
		expect(() => openVersioned(keys, sealed)).toThrow();
	});

	it("writes with TOKEN_VAULT_KEY when set and still opens k0 blobs", () => {
		const old = sealVersioned(keys, "old", bound);
		const rotated = vaultKeys({
			BETTER_AUTH_SECRET: secret,
			TOKEN_VAULT_KEY: "b".repeat(40),
		});
		const fresh = sealVersioned(rotated, "new", bound);
		expect(fresh.startsWith("v2.k1.")).toBe(true);
		expect(openVersioned(rotated, old, bound)).toBe("old");
		expect(openVersioned(rotated, fresh, bound)).toBe("new");
		expect(() => openVersioned(keys, fresh, bound)).toThrow(/k1/);
	});

	it("leaves legacy better-auth blobs recognisable as legacy", async () => {
		const legacy = await symmetricEncrypt({ key: secret, data: "legacy" });
		expect(isVersionedSeal(legacy)).toBe(false);
		expect(await symmetricDecrypt({ key: secret, data: legacy })).toBe(
			"legacy",
		);
	});
});

describe("binary sealing", () => {
	const bytes = new Uint8Array([0, 1, 2, 250, 255]);

	it("round-trips bytes bound to their purpose and user", () => {
		const binding = { purpose: "local-import:x:transcript.tgz", userId: "u" };
		const sealed = sealVersionedBytes(keys, bytes, binding);
		expect(Buffer.from(sealed).includes(Buffer.from(bytes))).toBe(false);
		expect([...openVersionedBytes(keys, sealed, binding)]).toEqual([...bytes]);
		expect(() =>
			openVersionedBytes(keys, sealed, { ...binding, userId: "v" }),
		).toThrow();
		expect(() =>
			openVersionedBytes(keys, sealed, { ...binding, purpose: "other" }),
		).toThrow();
	});

	it("never opens a tampered or malformed value", () => {
		const sealed = sealVersionedBytes(keys, bytes);
		const tampered = new Uint8Array(sealed);
		tampered[tampered.length - 1] ^= 1;
		expect(() => openVersionedBytes(keys, tampered)).toThrow();
		expect(() => openVersionedBytes(keys, new Uint8Array([1, 2, 3]))).toThrow();
	});
});
