import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { crewProjectFor } from "../../domain/y-squared-crew";
import { SqliteCrewScope } from "./crew-scope-store";

function sql() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) as never[] };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	};
}

describe("crew scope of a chat object", () => {
	it("is unknown until a resolved scope is remembered (a bare start never fills it)", () => {
		const scopes = new SqliteCrewScope(sql() as never);
		expect(crewProjectFor(scopes.read(), "t1")).toBeNull();
		// What background-jobs' startClaimedTurn / Claude Code route pass: no yEnabled.
		scopes.remember({});
		expect(scopes.read()).toBeNull();
		// What the object now resolves itself when such a turn starts.
		scopes.remember({ projectId: "p", yEnabled: true, ySquaredId: "y2" });
		expect(crewProjectFor(scopes.read(), "t1")).toBe("p");
		expect(crewProjectFor(scopes.read(), "y2")).toBeNull();
	});

	it("survives a restart of the object and follows the Y switch", () => {
		const db = sql();
		new SqliteCrewScope(db as never).remember({
			projectId: "p",
			yEnabled: true,
			ySquaredId: "y2",
		});
		const restarted = new SqliteCrewScope(db as never);
		expect(crewProjectFor(restarted.read(), "t1")).toBe("p");
		restarted.remember({ projectId: "p", yEnabled: false, ySquaredId: null });
		expect(
			crewProjectFor(new SqliteCrewScope(db as never).read(), "t1"),
		).toBeNull();
	});
});
