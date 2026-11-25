import { beforeEach, expect, it, vi } from "vitest";
import { GITHUB_SETUP_MESSAGE } from "#/domain/github-sign-in";

const query = vi.fn();
vi.mock("../adapters/database", () => ({ database: () => ({ query }) }));
vi.mock("../adapters/workspace-events", () => ({
	recordWorkspaceEvent: vi.fn(async () => undefined),
}));

import { failEnvironmentPreflight } from "./environment-build";

beforeEach(() => query.mockReset());

it("tells a user with no GitHub link to connect it, instead of the generic failure", async () => {
	query
		.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] })
		.mockResolvedValue({ rows: [] });
	await failEnvironmentPreflight("w1");
	expect(query.mock.calls[1]?.[1]).toEqual(["w1", GITHUB_SETUP_MESSAGE]);
});

it("keeps the generic message when the link exists", async () => {
	query.mockResolvedValue({ rows: [] });
	await failEnvironmentPreflight("w1");
	expect(String(query.mock.calls[1]?.[1]?.[1])).toContain(
		"Check repository access",
	);
});
