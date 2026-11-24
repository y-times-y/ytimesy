import { describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("./database", () => ({ database: () => ({ query }) }));

import { saveProjectGroup } from "./projects";

describe("a new project", () => {
	it("is a Y project, so its Y² (the super agent) is created with its first thread", async () => {
		query
			.mockReset()
			.mockImplementation(async (sql: string) =>
				sql.includes("insert into project(")
					? { rows: [], rowCount: 1 }
					: { rows: [{ id: "p1", name: "app" }], rowCount: 1 },
			);
		await saveProjectGroup("u1", "app", [
			{
				repositoryId: 1,
				installationId: 2,
				fullName: "o/app",
				branch: "main",
			} as never,
		]).catch(() => undefined);
		const insert = query.mock.calls.find(([sql]) =>
			String(sql).includes("insert into project("),
		)?.[0] as string;
		expect(insert).toMatch(/repository_set_key,y_enabled\)/);
		expect(insert).toMatch(
			/\$9,coalesce\(\(select enabled from user_y_setting where user_id=\$2\),true\)\)/,
		);
	});
});
