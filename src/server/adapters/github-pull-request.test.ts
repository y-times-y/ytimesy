import { beforeEach, expect, it, vi } from "vitest";
import {
	ensureDraftPullRequest,
	listSessionPullRequests,
	mergePullRequest,
} from "./github";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
	paginate: vi.fn(),
	merge: vi.fn(),
	repository: vi.fn(),
}));
vi.mock("@octokit/rest", () => ({
	Octokit: class {
		pulls = {
			list: api.list,
			create: api.create,
			get: api.get,
			merge: api.merge,
		};
		repos = { get: api.repository };
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
	api.create.mockRejectedValueOnce(alreadyExists);
	expect((await ensureDraftPullRequest("token", "owner/repo", draft)).url).toBe(
		pull.html_url,
	);
});
const alreadyExists = {
	status: 422,
	message: "Validation Failed",
	response: {
		data: {
			message: "Validation Failed",
			errors: [
				{
					resource: "PullRequest",
					code: "custom",
					message: `A pull request already exists for owner:${draft.head}.`,
				},
			],
		},
	},
};
it("says a PR already exists only when GitHub says so", async () => {
	api.create.mockRejectedValueOnce(alreadyExists);
	await expect(
		ensureDraftPullRequest("token", "owner/repo", draft),
	).rejects.toMatchObject({ status: 409 });
});
it("retries as a normal PR when the repository's plan has no draft PRs", async () => {
	api.create
		.mockRejectedValueOnce({
			status: 422,
			message: "Draft pull requests are not supported in this repository.",
			response: {
				data: {
					message: "Draft pull requests are not supported in this repository.",
				},
			},
		})
		.mockResolvedValueOnce({ data: { ...pull, draft: false } });
	const created = await ensureDraftPullRequest("token", "owner/repo", draft);
	expect(created).toEqual({ number: 1, url: pull.html_url, draft: false });
	expect(api.create).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({ draft: true }),
	);
	expect(api.create).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({ draft: false }),
	);
});
it("shows GitHub's real reason for any other refusal", async () => {
	api.create.mockRejectedValueOnce({
		status: 422,
		response: {
			data: {
				message: "Validation Failed",
				errors: [{ message: "No commits between main and ytimesy/x" }],
			},
		},
	});
	const noCommits = await ensureDraftPullRequest(
		"token",
		"owner/repo",
		draft,
	).catch((error: Response) => error);
	expect(noCommits).toMatchObject({ status: 422 });
	expect(await (noCommits as Response).text()).toMatch(/no commits ahead/);
	api.create.mockRejectedValueOnce({
		status: 422,
		response: {
			data: {
				message: "Validation Failed",
				errors: [{ message: "base: invalid branch" }],
			},
		},
	});
	const other = await ensureDraftPullRequest(
		"token",
		"owner/repo",
		draft,
	).catch((error: Response) => error);
	expect(other).toMatchObject({ status: 422 });
	expect(await (other as Response).text()).toBe(
		"GitHub refused to open the pull request: Validation Failed base: invalid branch",
	);
	expect(api.create).toHaveBeenCalledTimes(2);
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
it("merges with a method the repository allows, preferring squash", async () => {
	api.repository.mockResolvedValue({
		data: { allow_squash_merge: false, allow_merge_commit: true },
	});
	await mergePullRequest("token", "owner/repo", 1, "abc");
	expect(api.merge).toHaveBeenCalledWith(
		expect.objectContaining({ merge_method: "merge", sha: "abc" }),
	);
	api.repository.mockResolvedValue({ data: {} });
	await mergePullRequest("token", "owner/repo", 1, "abc");
	expect(api.merge).toHaveBeenLastCalledWith(
		expect.objectContaining({ merge_method: "squash" }),
	);
});
it("explains GitHub's merge refusals instead of failing generically", async () => {
	api.repository.mockResolvedValue({ data: {} });
	api.merge.mockRejectedValueOnce({
		status: 409,
		message: "Head branch was modified.",
	});
	const moved = await mergePullRequest("token", "owner/repo", 1, "abc").catch(
		(error: Response) => error,
	);
	expect(moved).toBeInstanceOf(Response);
	expect(await (moved as Response).text()).toMatch(
		/changed since you reviewed/,
	);
	api.merge.mockRejectedValueOnce({
		status: 405,
		message:
			'Required status check "ci" is expected. - https://docs.github.com/rest',
	});
	const blocked = (await mergePullRequest(
		"token",
		"owner/repo",
		1,
		"abc",
	).catch((error: Response) => error)) as Response;
	expect(blocked.status).toBe(409);
	expect(await blocked.text()).toBe(
		'GitHub\'s branch protection blocked the merge: Required status check "ci" is expected.',
	);
	api.repository.mockResolvedValue({
		data: {
			allow_squash_merge: false,
			allow_merge_commit: false,
			allow_rebase_merge: false,
		},
	});
	await expect(
		mergePullRequest("token", "owner/repo", 1, "abc"),
	).rejects.toMatchObject({ status: 409 });
});
