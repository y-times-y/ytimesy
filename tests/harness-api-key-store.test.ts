import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	decryptHarnessApiKey,
	listHarnessApiKeys,
	saveHarnessApiKey,
} from "../src/server/secrets/harness-key-store";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({ database: () => db }));
vi.mock("../src/server/auth/token-vault", () => ({
	seal: (data: string) =>
		symmetricEncrypt({ key: "test-key-not-for-production", data }),
	unseal: (data: string) =>
		symmetricDecrypt({ key: "test-key-not-for-production", data }),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values ('alice'), ('bob');",
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260927190000_user_harness_api_keys.sql",
			"utf8",
		),
	);
});
afterAll(async () => {
	await db.close();
});

it("encrypts keys and isolates owners, including replacement", async () => {
	await saveHarnessApiKey("alice", "claude", "alice-test-api-key");
	expect(await decryptHarnessApiKey("bob", "claude")).toBeNull();
	expect(await listHarnessApiKeys("bob")).toEqual([]);
	await saveHarnessApiKey("bob", "claude", "bob-test-api-key");
	await saveHarnessApiKey("alice", "claude", "alice-replacement-key");
	expect(await decryptHarnessApiKey("bob", "claude")).toBe("bob-test-api-key");
	expect(await decryptHarnessApiKey("alice", "claude")).toBe(
		"alice-replacement-key",
	);
	const stored = await db.query(
		"select encrypted_key from user_harness_api_key",
	);
	expect(JSON.stringify(stored.rows)).not.toContain("alice-replacement-key");
	const publicKeys = await listHarnessApiKeys("alice");
	expect(publicKeys).toHaveLength(1);
	expect(Object.keys(publicKeys[0]).sort()).toEqual(["harnessId", "hint"]);
});
it("denies direct browser roles access", async () => {
	await db.exec("set role authenticated");
	await expect(
		db.query("select * from user_harness_api_key"),
	).rejects.toThrow();
	await db.exec("reset role");
});
