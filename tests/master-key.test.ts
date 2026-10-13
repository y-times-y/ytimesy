import { afterEach, expect, it, vi } from "vitest";
import { loadSecretMasterKey } from "../src/server/secrets/master-key";

afterEach(() => vi.unstubAllEnvs());

it("refuses to create a replacement key in production", async () => {
	vi.stubEnv("YTIMESY_SECRETS_KEY", "");
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	await expect(loadSecretMasterKey()).rejects.toThrow(
		"YTIMESY_SECRETS_KEY is required in production.",
	);
});

it("uses the configured key", async () => {
	vi.stubEnv("YTIMESY_SECRETS_KEY", "ab".repeat(32));
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	expect((await loadSecretMasterKey()).byteLength).toBe(32);
});
