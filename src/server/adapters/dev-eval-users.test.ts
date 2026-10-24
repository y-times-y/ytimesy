import { beforeEach, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("./database", () => ({ database: () => ({ query }) }));

beforeEach(() => {
	vi.resetModules();
	query.mockReset();
	vi.unstubAllEnvs();
});

it("recognizes an eval user even where the eval-user switches are off (production)", async () => {
	vi.stubEnv("YTIMESY_DEV_EVAL_USERS", "");
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	query.mockImplementation(async (_sql: string, [userId]: string[]) => ({
		rows:
			userId === "eval-user"
				? [{ owner_user_id: "owner", harness_variant: {} }]
				: [],
	}));
	const { isDevEvalUser, harnessVariantForUser } = await import(
		"./dev-eval-users"
	);
	await expect(isDevEvalUser("eval-user")).resolves.toBe(true);
	await expect(isDevEvalUser("person")).resolves.toBe(false);
	// The variant switch stays gated: production never reads variants.
	await harnessVariantForUser("eval-user");
	expect(query).toHaveBeenCalledTimes(2);
});

it("gives real users builder subagents; an eval user keeps the eval baseline", async () => {
	vi.stubEnv("YTIMESY_DEV_EVAL_USERS", "1");
	vi.stubEnv("YTIMESY_ENVIRONMENT", "development");
	query.mockImplementation(async (_sql: string, [userId]: string[]) => ({
		rows:
			userId === "eval-user"
				? [{ owner_user_id: "owner", harness_variant: {} }]
				: [],
	}));
	const { harnessVariantForUser } = await import("./dev-eval-users");
	expect((await harnessVariantForUser("person")).subagents).toBe("on");
	expect((await harnessVariantForUser("eval-user")).subagents).toBe("off");
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	expect((await harnessVariantForUser("person")).subagents).toBe("on");
});
