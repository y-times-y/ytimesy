import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	projectMachineSize,
	saveProjectMachineSize,
} from "../src/server/adapters/project-machine-size";

let db: PGlite;
const projectId = "11111111-1111-4111-8111-111111111111";
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		`create table project(id uuid primary key, user_id text); insert into project values('${projectId}','alice')`,
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261004020000_project_machine_size.sql",
			"utf8",
		),
	);
});
afterAll(() => db.close());
it("backfills Large and persists preferences for the project owner", async () => {
	expect(await projectMachineSize("alice", projectId)).toBe("large");
	await saveProjectMachineSize("alice", projectId, "small");
	expect(await projectMachineSize("alice", projectId)).toBe("small");
});
it("blocks another owner and rejects unknown sizes at both boundaries", async () => {
	await expect(projectMachineSize("bob", projectId)).rejects.toThrow(
		"not available",
	);
	await expect(
		saveProjectMachineSize("bob", projectId, "large"),
	).rejects.toThrow("not available");
	await expect(
		db.exec(`update project set machine_size='huge' where id='${projectId}'`),
	).rejects.toThrow();
	expect(await projectMachineSize("alice", projectId)).toBe("small");
});
