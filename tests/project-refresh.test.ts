import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	refreshProjectRepository,
	saveProjectGroup,
} from "../src/server/adapters/projects";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params?: unknown[]) => db.query(sql, params),
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());

it("refreshes a re-added repository's installation, name and branch on the project and its repository row", async () => {
	const saved = await saveProjectGroup("alice", "repo", [
		{
			repositoryId: 2,
			installationId: 1,
			fullName: "old/repo",
			branch: "main",
		},
	]);
	const refreshed = await refreshProjectRepository(
		"alice",
		saved.id,
		{
			repositoryId: 2,
			installationId: 9,
			fullName: "new/renamed",
			branch: "dev",
		},
		null,
	);
	expect(refreshed).toMatchObject({
		id: saved.id,
		name: "repo",
		installationId: 9,
		fullName: "new/renamed",
		branch: "dev",
		repositories: [
			{
				repositoryId: 2,
				installationId: 9,
				fullName: "new/renamed",
				branch: "dev",
			},
		],
	});
	const renamed = await refreshProjectRepository(
		"alice",
		saved.id,
		{
			repositoryId: 2,
			installationId: 9,
			fullName: "new/renamed",
			branch: "dev",
		},
		"My app",
	);
	expect(renamed.name).toBe("My app");
	await expect(
		refreshProjectRepository(
			"bob",
			saved.id,
			{ repositoryId: 2, installationId: 5, fullName: "x/y", branch: "main" },
			null,
		),
	).rejects.toBeInstanceOf(Response);
	const row = await db.query<{ installation_id: string }>(
		"select installation_id from project where id=$1",
		[saved.id],
	);
	expect(Number(row.rows[0].installation_id)).toBe(9);
});
