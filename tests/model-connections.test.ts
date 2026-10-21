import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	claimModelProbe,
	listModelConnections,
	loadModelConnection,
	markModelVerified,
	removeModelConnection,
	saveModelConnection,
} from "../src/server/adapters/model-connections";
import { seal } from "../src/server/auth/token-vault";
import { connectionApiKey } from "../src/server/services/model-connections";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		BETTER_AUTH_SECRET: "fixture-secret-longer-than-thirty-two-characters",
	}),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values ('alice'),('bob');",
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260927183000_model_connections.sql",
			"utf8",
		),
	);
});
afterAll(() => db.close());

async function connection() {
	const id = randomUUID();
	const input = {
		id,
		provider: "openai" as const,
		label: "Work",
		baseUrl: "https://api.openai.com/v1",
		models: [
			{
				id: "fixture-model",
				label: "Fixture model",
				toolStreamingVerified: false,
			},
		],
		sealedCredential: await seal(
			JSON.stringify({ id, userId: "alice", apiKey: "fixture-only-secret" }),
			{ purpose: "model-credential", userId: "alice" },
		),
	};
	await saveModelConnection("alice", input, false);
	return input;
}

it("applies the migration, encrypts keys, and excludes ciphertext from public listings", async () => {
	const input = await connection();
	const stored = await loadModelConnection("alice", input.id);
	if (!stored) throw new Error("Missing fixture connection");
	expect(stored?.sealedCredential).not.toContain("fixture-only-secret");
	expect(await connectionApiKey("alice", stored)).toBe("fixture-only-secret");
	expect(
		(await listModelConnections("alice")).find((row) => row.id === input.id),
	).not.toHaveProperty("sealedCredential");
	await expect(connectionApiKey("bob", stored)).rejects.toThrow(
		"ownership mismatch",
	);
	await expect(
		connectionApiKey("alice", { ...stored, id: randomUUID() }),
	).rejects.toThrow("ownership mismatch");
});

it("isolates reads, replacements, verification and deletes by owner", async () => {
	const input = await connection();
	const stored = await loadModelConnection("alice", input.id);
	if (!stored) throw new Error("Missing fixture connection");
	expect(await loadModelConnection("bob", input.id)).toBeNull();
	expect(await listModelConnections("bob")).toEqual([]);
	await expect(saveModelConnection("bob", input, true)).rejects.toThrow(
		"not available",
	);
	expect(await claimModelProbe("bob", input.id, stored.revision)).toBe(false);
	expect(
		await markModelVerified("bob", input.id, stored.revision, "fixture-model"),
	).toBe(false);
	await removeModelConnection("bob", input.id);
	expect(await loadModelConnection("alice", input.id)).not.toBeNull();
	await removeModelConnection("alice", input.id);
	expect(await loadModelConnection("alice", input.id)).toBeNull();
});

it("throttles probes and rejects results for replaced credentials", async () => {
	const input = await connection();
	const stored = await loadModelConnection("alice", input.id);
	if (!stored) throw new Error("Missing fixture connection");
	expect(await claimModelProbe("alice", input.id, stored.revision)).toBe(true);
	expect(await claimModelProbe("alice", input.id, stored.revision)).toBe(false);
	expect(
		await markModelVerified(
			"alice",
			input.id,
			stored.revision,
			"fixture-model",
		),
	).toBe(true);
	expect(
		(await loadModelConnection("alice", input.id))?.models[0]
			.toolStreamingVerified,
	).toBe(true);
	await saveModelConnection("alice", input, true);
	expect(
		await markModelVerified(
			"alice",
			input.id,
			stored.revision,
			"fixture-model",
		),
	).toBe(false);
	expect(
		(await loadModelConnection("alice", input.id))?.models[0]
			.toolStreamingVerified,
	).toBe(false);
});

it("denies direct client-role access even if the owner id is known", async () => {
	await db.exec("set role authenticated");
	try {
		await expect(db.query("select * from model_connection")).rejects.toThrow(
			"permission denied",
		);
	} finally {
		await db.exec("reset role");
	}
});
