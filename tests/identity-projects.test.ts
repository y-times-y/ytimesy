import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listProjects, saveProject } from "../src/server/adapters/projects";
import { requireSameOrigin } from "../src/server/http";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({ APP_URL: "http://127.0.0.1:3001" }),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20260913010000_enable_automatic_rls.sql",
		"20260913193000_identity_and_projects.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());
describe("personal project ownership", () => {
	const repo = {
		installationId: 1,
		repositoryId: 2,
		fullName: "test/repo",
		defaultBranch: "main",
	};
	it("keeps two users on the same repository isolated, including branch updates", async () => {
		const alice = await saveProject("alice", repo, "main");
		const bob = await saveProject("bob", repo, "develop");
		expect(alice.id).not.toBe(bob.id);
		await saveProject("alice", repo, "feature");
		expect(await listProjects("alice")).toEqual([
			{ ...alice, branch: "feature" },
		]);
		expect(await listProjects("bob")).toEqual([bob]);
		expect(await listProjects("unknown")).toEqual([]);
	});
	it("enables RLS and denies Data API roles access to every new table", async () => {
		const result = await db.query<{ relname: string; relrowsecurity: boolean }>(
			"select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'",
		);
		expect(result.rows).toHaveLength(8);
		expect(result.rows.every((row) => row.relrowsecurity)).toBe(true);
		for (const role of ["anon", "authenticated"]) {
			const grants = await db.query<{ allowed: boolean }>(
				"select has_table_privilege($1,'project','SELECT') as allowed",
				[role],
			);
			expect(grants.rows[0].allowed).toBe(false);
		}
	});
	it("rejects unknown owners through the database foreign key", async () => {
		await expect(saveProject("unknown", repo, "main")).rejects.toThrow();
	});
});
describe("mutation origin boundary", () => {
	it.each([undefined, "https://attacker.test", "http://localhost:3001"])(
		"rejects mismatched origin %s",
		(origin) => {
			expect(() =>
				requireSameOrigin(
					new Request("http://127.0.0.1:3001/api/projects", {
						method: "POST",
						headers: {
							...(origin ? { origin } : {}),
							"Content-Type": "application/json",
						},
					}),
				),
			).toThrow();
		},
	);
	it("accepts a same-origin JSON request", () => {
		expect(() =>
			requireSameOrigin(
				new Request("http://127.0.0.1:3001/api/projects", {
					method: "POST",
					headers: {
						origin: "http://127.0.0.1:3001",
						"Content-Type": "application/json",
					},
				}),
			),
		).not.toThrow();
	});
});
