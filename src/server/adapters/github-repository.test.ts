import { beforeEach, expect, it, vi } from "vitest";
import { createAuthorizedRepository } from "./github";

const api = vi.hoisted(() => ({
	create: vi.fn(),
	paginate: vi.fn(),
	addRepo: vi.fn(),
}));
vi.mock("@octokit/rest", () => ({
	Octokit: class {
		repos = { createForAuthenticatedUser: api.create };
		apps = {
			listInstallationsForAuthenticatedUser: vi.fn(),
			addRepoToInstallationForAuthenticatedUser: api.addRepo,
		};
		paginate = api.paginate;
	},
}));
vi.mock("../config", () => ({
	serverConfig: () => ({ GITHUB_APP_SLUG: "ytimesy" }),
}));

const installation = (id: number, login: string, selection = "selected") => ({
	id,
	suspended_at: null,
	app_slug: "ytimesy",
	permissions: { contents: "write" },
	account: { login },
	repository_selection: selection,
});
beforeEach(() => {
	vi.resetAllMocks();
	api.create.mockResolvedValue({
		data: {
			id: 7,
			full_name: "Alice/scratch",
			default_branch: "main",
			owner: { login: "Alice" },
		},
	});
});

it("grants the new repository through the owner's installation, not an organization's", async () => {
	api.paginate.mockResolvedValue([
		installation(1, "acme"),
		installation(2, "alice"),
	]);
	const repository = await createAuthorizedRepository("token", "scratch");
	expect(repository.installationId).toBe(2);
	expect(api.addRepo).toHaveBeenCalledWith({
		installation_id: 2,
		repository_id: 7,
	});
});

it("skips the grant for all-repository installations", async () => {
	api.paginate.mockResolvedValue([installation(2, "alice", "all")]);
	await createAuthorizedRepository("token", "scratch");
	expect(api.addRepo).not.toHaveBeenCalled();
});

it("reports a failed grant instead of returning an unusable repository", async () => {
	api.paginate.mockResolvedValue([installation(2, "alice")]);
	api.addRepo.mockRejectedValue({ status: 403 });
	const failure = (await createAuthorizedRepository("token", "scratch").catch(
		(error: Response) => error,
	)) as Response;
	expect(failure.status).toBe(409);
	expect(await failure.text()).toMatch(/did not grant ytimesy access/);
});

it("explains when the app is installed only on other accounts", async () => {
	api.paginate.mockResolvedValue([installation(1, "acme")]);
	const failure = (await createAuthorizedRepository("token", "scratch").catch(
		(error: Response) => error,
	)) as Response;
	expect(await failure.text()).toMatch(/not installed on Alice/);
});
