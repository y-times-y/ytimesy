import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { environmentRecipe } from "../src/domain/project-environment";
import { projectGroupSelection } from "../src/domain/projects";
import {
	listProjects,
	projectForOwner,
	saveProject,
	saveProjectGroup,
} from "../src/server/adapters/projects";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20260913010000_enable_automatic_rls.sql",
		"20260913193000_identity_and_projects.sql",
		"20260913221500_workspaces_jobs_agent_accounts.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values ('alice','Alice','alice@test.invalid',true),('bob','Bob','bob@test.invalid',true)`,
	);
	// Insert through the preceding schema to test the actual upgrade/backfill.
	await db.exec(
		"insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('11111111-1111-4111-8111-111111111111','alice',1,1,'org/web','main')",
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20260927210000_project_environments.sql",
			"utf8",
		),
	);
});
afterAll(() => db.close());

it("backfills existing single-repository projects and keeps branch updates synchronized", async () => {
	await saveProject(
		"alice",
		{
			installationId: 1,
			repositoryId: 1,
			fullName: "org/web",
			defaultBranch: "main",
		},
		"feature",
	);
	const result = await db.query<{ branch: string }>(
		"select branch from project_repository where project_id='11111111-1111-4111-8111-111111111111'",
	);
	expect(result.rows[0].branch).toBe("feature");
});

it("stores multiple repositories atomically without replacing an existing project", async () => {
	const repos = [
		{ installationId: 1, repositoryId: 1, fullName: "org/web", branch: "main" },
		{
			installationId: 2,
			repositoryId: 2,
			fullName: "org/api",
			branch: "develop",
		},
	];
	const project = await saveProjectGroup("alice", "Product", repos);
	expect(project.repositories).toEqual(repos);
	expect(await listProjects("alice")).toHaveLength(2);
	expect(await projectForOwner("bob", project.id)).toBeNull();
});

it("rejects duplicate repository selection and invalid service configuration", () => {
	const repo = { installationId: 1, repositoryId: 2, branch: "main" };
	expect(
		projectGroupSelection.safeParse({ name: "App", repositories: [repo, repo] })
			.success,
	).toBe(false);
	expect(
		environmentRecipe.safeParse({
			services: [
				{ name: "web", command: "npm start", port: 3000 },
				{ name: "api", command: "npm start", port: 3000 },
			],
		}).success,
	).toBe(false);
	expect(
		environmentRecipe.safeParse({ verify: ["npm test"], unknown: "x" }).success,
	).toBe(false);
});

it("keeps new records inaccessible to Data API roles", async () => {
	for (const table of ["project_repository", "environment_build"]) {
		const result = await db.query<{ allowed: boolean }>(
			"select has_table_privilege('authenticated',$1,'SELECT') as allowed",
			[table],
		);
		expect(result.rows[0].allowed).toBe(false);
	}
});
