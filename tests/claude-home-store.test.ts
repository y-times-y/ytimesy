import { afterEach, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params: unknown[]) => {
			if (sql.startsWith("select"))
				return {
					rows: rows.has(params[0] as string)
						? [{ encrypted: rows.get(params[0] as string) }]
						: [],
				};
			rows.set(params[0] as string, JSON.parse(params[1] as string));
			return { rows: [] };
		},
	}),
}));

import {
	loadClaudeHomeForUser,
	saveClaudeHomeForUser,
} from "../src/server/secrets/claude-home-store";

afterEach(() => {
	vi.unstubAllEnvs();
	rows.clear();
});

it("stores Claude home files encrypted in Postgres and reads them back", async () => {
	vi.stubEnv("YTIMESY_SECRETS_KEY", "cd".repeat(32));
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	const files = {
		".claude/.credentials.json":
			'{"claudeAiOauth":{"accessToken":"t","refreshToken":"r"}}',
		".claude.json": '{"oauthAccount":{"emailAddress":"a@b.c"}}',
	};
	await saveClaudeHomeForUser("u1", { files } as never);
	expect(JSON.stringify(rows.get("u1"))).not.toContain("accessToken");
	expect((await loadClaudeHomeForUser("u1"))?.files).toEqual(files);
	expect(await loadClaudeHomeForUser("u2")).toBeNull();
});
