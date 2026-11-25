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
		.mockResolvedValueOnce({ rows: [{ user_id: "u", unlinked: true }] })
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

it("gives the synthetic account the real reason, never the GitHub prompt", async () => {
	query
		.mockResolvedValueOnce({
			rows: [{ user_id: "ytimesy-test-account", unlinked: true }],
		})
		.mockResolvedValue({ rows: [] });
	await failEnvironmentPreflight("w1", "Not Found");
	expect(String(query.mock.calls[1]?.[1]?.[1])).toContain("(Not Found)");
});
