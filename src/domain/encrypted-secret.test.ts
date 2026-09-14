import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, secretHint } from "./encrypted-secret";

describe("encrypted secrets", () => {
	it("round-trips plaintext and never puts it in the stored record", () => {
		const masterKey = Buffer.alloc(32, 7);
		const secret = encryptSecret(masterKey, "sk-test-secret-value");
		expect(JSON.stringify(secret)).not.toContain("sk-test-secret-value");
		expect(decryptSecret(masterKey, secret)).toBe("sk-test-secret-value");
	});

	it("hints only the last four characters", () => {
		expect(secretHint("sk-abc1234xyz")).toBe("••••4xyz");
		expect(secretHint("ab")).toBe("••••");
	});
});
