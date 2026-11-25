import { expect, it, vi } from "vitest";

const query = vi.fn(async () => ({ rows: [] }));
vi.mock("../adapters/database", () => ({ database: () => ({ query }) }));

import { githubConnectionExists } from "./github-connection";

it("counts the synthetic account as connected without a database read", async () => {
	expect(await githubConnectionExists("ytimesy-test-account")).toBe(true);
	expect(query).not.toHaveBeenCalled();
});

it("still asks the database for everyone else", async () => {
	expect(await githubConnectionExists("someone")).toBe(false);
	expect(query).toHaveBeenCalledTimes(1);
});
