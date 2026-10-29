import { afterEach, expect, it, vi } from "vitest";
import { databaseConfig, serverConfig, vaultConfig } from "./config";

const required = {
	APP_URL: "http://localhost:3000",
	BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
	DATABASE_URL: "postgres://test.invalid/db?sslmode=verify-full",
	GITHUB_OAUTH_CLIENT_ID: "test",
	GITHUB_OAUTH_CLIENT_SECRET: "test",
	GITHUB_APP_CLIENT_ID: "test",
	GITHUB_APP_CLIENT_SECRET: "test",
	GITHUB_APP_SLUG: "test",
};
afterEach(() => vi.unstubAllEnvs());
function configure(value: string | undefined) {
	for (const [key, setting] of Object.entries(required))
		vi.stubEnv(key, setting);
	vi.stubEnv("DATABASE_POOL_MAX", value);
}
it.each([undefined, ""])("uses a small default pool for %s", (value) => {
	configure(value);
	expect(serverConfig().DATABASE_POOL_MAX).toBe(2);
});
it("accepts an explicit per-process connection budget", () => {
	configure("6");
	expect(serverConfig().DATABASE_POOL_MAX).toBe(6);
});
it("opens the database and the token vault without the web app's settings", () => {
	for (const key of Object.keys(required)) vi.stubEnv(key, "");
	vi.stubEnv("DATABASE_URL", required.DATABASE_URL);
	vi.stubEnv("BETTER_AUTH_SECRET", required.BETTER_AUTH_SECRET);
	expect(() => serverConfig()).toThrow("APP_URL");
	expect(databaseConfig()).toMatchObject({
		DATABASE_URL: required.DATABASE_URL,
		DATABASE_POOL_MAX: 2,
	});
	expect(vaultConfig().BETTER_AUTH_SECRET).toBe(required.BETTER_AUTH_SECRET);
	vi.stubEnv("DATABASE_URL", "postgres://test.invalid/db");
	expect(() => databaseConfig()).toThrow("DATABASE_URL");
});
it.each(["0", "21", "NaN", "1.5", "-2"])(
	"rejects invalid pool size %s",
	(value) => {
		configure(value);
		expect(() => serverConfig()).toThrow("DATABASE_POOL_MAX");
	},
);
