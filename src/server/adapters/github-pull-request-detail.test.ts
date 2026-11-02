import { beforeEach, expect, it, vi } from "vitest";
import { authorizedRepository, pullRequestDetail } from "./github";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	listFiles: vi.fn(),
	listReviews: vi.fn(),
	listReviewComments: vi.fn(),
	listComments: vi.fn(),
	listForRef: vi.fn(),
	combinedStatus: vi.fn(),
	installations: vi.fn(),
	installationRepos: vi.fn(),
	paginate: vi.fn(),
}));
vi.mock("@octokit/rest", () => ({
	Octokit: class {
		pulls = {
			get: api.get,
			listFiles: api.listFiles,
			listReviews: api.listReviews,
			listReviewComments: api.listReviewComments,
		};
		issues = { listComments: api.listComments };
		checks = { listForRef: api.listForRef };
		repos = { getCombinedStatusForRef: api.combinedStatus };
		apps = {
			listInstallationsForAuthenticatedUser: api.installations,
			listInstallationReposForAuthenticatedUser: api.installationRepos,
		};
		paginate = api.paginate;
	},
}));
vi.mock("../config", () => {
	const serverConfig = () => ({ GITHUB_APP_SLUG: "ytimesy" });
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const pull = {
	number: 7,
	title: "Draft pull request",
	body: "",
	html_url: "https://github.com/acme/app/pull/7",
	state: "open",
	draft: true,
	merged: false,
	head: { ref: "ytimesy/fix", sha: "a".repeat(40) },
	base: { ref: "main" },
	user: { login: "ada", avatar_url: null, type: "User" },
	created_at: "2026-11-01T00:00:00Z",
	updated_at: "2026-11-01T00:00:00Z",
	mergeable: true,
	mergeable_state: "clean",
	additions: 3,
	deletions: 1,
	changed_files: 1,
	comments: 0,
	review_comments: 0,
};

beforeEach(() => {
	vi.resetAllMocks();
});

it("starts every pull request read at once and the checks as soon as the head is known", async () => {
	const reads = {
		pull: deferred<{ data: typeof pull }>(),
		files: deferred<unknown[]>(),
		reviews: deferred<{ data: unknown[] }>(),
		comments: deferred<{ data: unknown[] }>(),
		inline: deferred<{ data: unknown[] }>(),
	};
	api.get.mockReturnValue(reads.pull.promise);
	api.paginate.mockReturnValue(reads.files.promise);
	api.listReviews.mockReturnValue(reads.reviews.promise);
	api.listComments.mockReturnValue(reads.comments.promise);
	api.listReviewComments.mockReturnValue(reads.inline.promise);
	api.listForRef.mockResolvedValue({
		data: {
			check_runs: [
				{
					name: "ci",
					status: "completed",
					conclusion: "success",
					html_url: null,
				},
			],
		},
	});
	api.combinedStatus.mockResolvedValue({ data: { statuses: [] } });

	const detail = pullRequestDetail("token", "acme/app", 7);
	await flush();
	// Nothing has answered yet, and every independent read is already out.
	for (const call of [
		api.get,
		api.paginate,
		api.listReviews,
		api.listComments,
		api.listReviewComments,
	])
		expect(call).toHaveBeenCalledTimes(1);
	expect(api.listForRef).not.toHaveBeenCalled();

	reads.pull.resolve({ data: pull });
	await flush();
	// The checks follow the pull request, not the slower file list.
	expect(api.listForRef).toHaveBeenCalledWith(
		expect.objectContaining({ ref: pull.head.sha }),
	);
	expect(api.combinedStatus).toHaveBeenCalledTimes(1);

	reads.files.resolve([]);
	reads.reviews.resolve({ data: [] });
	reads.comments.resolve({ data: [] });
	reads.inline.resolve({ data: [] });
	const result = await detail;
	expect(result).toMatchObject({
		number: 7,
		state: "draft",
		head: "ytimesy/fix",
		checks: [{ name: "ci", state: "passed" }],
	});
	expect(api.get).toHaveBeenCalledTimes(1);
});

const ours = {
	id: 11,
	suspended_at: null,
	app_slug: "ytimesy",
	permissions: { contents: "write" },
};
const repo = (id: number) => ({
	id,
	full_name: `acme/repo-${id}`,
	default_branch: "main",
	private: true,
	permissions: { push: true },
});
type Page = { data: ReturnType<typeof repo>[] };

/** paginate for the two listings; repository pages stop once the mapper says done. */
function fakeGithub({
	installations,
	pages,
	installationsReady = Promise.resolve(),
}: {
	installations: (typeof ours)[];
	pages: Page[];
	installationsReady?: Promise<void>;
}) {
	const read: number[] = [];
	api.paginate.mockImplementation(
		async (
			route: unknown,
			_params: unknown,
			map?: (page: Page, done: () => void) => unknown[],
		) => {
			if (route === api.installations) {
				await installationsReady;
				return installations;
			}
			const rows: unknown[] = [];
			for (const [index, page] of pages.entries()) {
				read.push(index);
				let stop = false;
				rows.push(...(map ? map(page, () => (stop = true)) : page.data));
				if (stop) break;
			}
			return rows;
		},
	);
	return read;
}

it("checks one installation's repositories alongside the installations, stopping at the repository's page", async () => {
	const installationsReady = deferred<void>();
	const pagesRead = fakeGithub({
		installations: [ours],
		pages: [
			{ data: [repo(1), repo(2)] },
			{ data: [repo(3)] },
			{ data: [repo(4)] },
		],
		installationsReady: installationsReady.promise,
	});
	const access = authorizedRepository("token", 11, 3);
	await flush();
	// The repository listing did not wait for the installations.
	expect(api.paginate).toHaveBeenCalledTimes(2);
	expect(api.paginate).toHaveBeenCalledWith(
		api.installationRepos,
		expect.objectContaining({ installation_id: 11 }),
		expect.any(Function),
	);
	installationsReady.resolve();
	await expect(access).resolves.toEqual({
		installationId: 11,
		repositoryId: 3,
		fullName: "acme/repo-3",
		defaultBranch: "main",
		private: true,
	});
	expect(pagesRead).toEqual([0, 1]);
});

it("refuses a repository outside the user's usable installations", async () => {
	fakeGithub({ installations: [ours], pages: [{ data: [repo(1)] }] });
	await expect(authorizedRepository("token", 11, 2)).rejects.toMatchObject({
		status: 403,
	});
	fakeGithub({
		installations: [{ ...ours, suspended_at: "2026-11-01T00:00:00Z" } as never],
		pages: [{ data: [repo(1)] }],
	});
	await expect(authorizedRepository("token", 11, 1)).rejects.toMatchObject({
		status: 403,
	});
	fakeGithub({
		installations: [ours],
		pages: [{ data: [{ ...repo(1), permissions: { push: false } }] }],
	});
	await expect(authorizedRepository("token", 11, 1)).rejects.toMatchObject({
		status: 403,
	});
	fakeGithub({ installations: [ours], pages: [{ data: [repo(1)] }] });
	await expect(authorizedRepository("token", 12, 1)).rejects.toMatchObject({
		status: 403,
	});
});
