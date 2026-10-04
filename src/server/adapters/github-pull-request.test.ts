import { beforeEach, expect, it, vi } from "vitest";
import { ensureDraftPullRequest, listSessionPullRequests } from "./github";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	paginate: vi.fn(),
}));
vi.mock("@octokit/rest", () => ({
	Octokit: class {
		pulls = { list: api.list, create: api.create, get: api.get };
		paginate = api.paginate;
	},
}));
const draft = {
	title: "Fix parser",
	body: "Evidence",
	head: "ytimesy/fix-parser-abcd",
	base: "main",
};
const pull = {
	number: 1,
	html_url: "https://github.com/owner/repo/pull/1",
	draft: true,
	head: { ref: draft.head, repo: { full_name: "owner/repo" } },
	base: { ref: "main" },
};
beforeEach(() => {
	vi.resetAllMocks();
	api.list.mockResolvedValue({ data: [] });
	api.create.mockResolvedValue({ data: pull });
});
it("reuses the existing open PR on follow-up handoffs", async () => {
	api.list.mockResolvedValue({ data: [pull] });
	expect((await ensureDraftPullRequest("token", "owner/repo", draft)).url).toBe(
		pull.html_url,
	);
	expect(api.create).not.toHaveBeenCalled();
	expect(api.list).toHaveBeenCalledWith(
		expect.objectContaining({
			head: `owner:${draft.head}`,
			base: "main",
			state: "open",
		}),
	);
});
it("creates a draft and recovers a simultaneous creation race", async () => {
	await ensureDraftPullRequest("token", "owner/repo", draft);
	expect(api.create).toHaveBeenCalledWith(
		expect.objectContaining({ draft: true }),
	);
	api.list
		.mockResolvedValueOnce({ data: [] })
		.mockResolvedValueOnce({ data: [pull] });
	api.create.mockRejectedValueOnce({ status: 422 });
	expect((await ensureDraftPullRequest("token", "owner/repo", draft)).url).toBe(
		pull.html_url,
	);
});
it("keeps provider errors visible when no matching PR exists", async () => {
	api.create.mockRejectedValueOnce({ status: 422 });
	await expect(
		ensureDraftPullRequest("token", "owner/repo", draft),
	).rejects.toMatchObject({ status: 409 });
});
it("lists both current and legacy task prefixes", async () => {
	api.paginate.mockResolvedValue([
		pull,
		{ ...pull, number: 2, head: { ref: "ytimesy-legacy" } },
		{ ...pull, number: 3, head: { ref: "feature/unrelated" } },
	]);
	api.get.mockImplementation(async ({ pull_number }) => ({
		data: { ...pull, number: pull_number },
	}));
	expect(await listSessionPullRequests("token", "owner/repo")).toHaveLength(2);
	expect(api.get).toHaveBeenCalledTimes(2);
});
