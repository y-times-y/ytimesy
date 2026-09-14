import { describe, expect, it } from "vitest";
import {
	branchesForPicker,
	catalogStatusCopy,
	gitHubProjectCatalog,
	gitHubRepositoryFromApi,
	githubAppInstallUrl,
	githubProjectId,
	parseGitHubProjectId,
	publicProjectPicker,
	resolveSelectedBranch,
	resolveSelectedProject,
	selectionNeedsPersist,
} from "./github-project";
import { ProjectId } from "./ids";

const ytimesy = {
	owner: "y-times-y",
	name: "ytimesy",
	fullName: "y-times-y/ytimesy",
	defaultBranch: "master",
	private: true,
	installationId: "161432829",
};

describe("githubProjectId", () => {
	it("brands owner/name as a GitHub project", () => {
		expect(githubProjectId(" y-times-y/ytimesy ")).toBe(
			"github:y-times-y/ytimesy",
		);
		expect(parseGitHubProjectId(githubProjectId("y-times-y/ytimesy"))).toEqual({
			owner: "y-times-y",
			name: "ytimesy",
		});
	});

	it("rejects names that are not owner/name", () => {
		expect(() => githubProjectId("ytimesy")).toThrow("owner/name");
		expect(() => githubProjectId("a/b/c")).toThrow("owner/name");
		expect(parseGitHubProjectId(ProjectId("local:ytimesy"))).toBeNull();
	});
});

describe("gitHubRepositoryFromApi", () => {
	it("reads an installation repository payload", () => {
		expect(
			gitHubRepositoryFromApi("161432829", {
				name: "ytimesy",
				full_name: "y-times-y/ytimesy",
				default_branch: "master",
				private: true,
				owner: { login: "y-times-y" },
			}),
		).toEqual(ytimesy);
	});

	it("drops incomplete payloads instead of fabricating a repo", () => {
		expect(gitHubRepositoryFromApi("1", { name: "ytimesy" })).toBeNull();
		expect(gitHubRepositoryFromApi(" ", ytimesy)).toBeNull();
	});
});

describe("gitHubProjectCatalog", () => {
	it("stays unconfigured until App credentials exist", () => {
		const catalog = gitHubProjectCatalog({
			credentialsPresent: false,
			installUrl: null,
			installationCount: 0,
			repositories: [],
		});
		expect(catalog.status).toBe("unconfigured");
		expect(catalogStatusCopy(catalog)).toBe(
			"GitHub App credentials are not configured.",
		);
	});

	it("asks to install when the App has no installations", () => {
		const catalog = gitHubProjectCatalog({
			credentialsPresent: true,
			installUrl: githubAppInstallUrl("ytimesy"),
			installationCount: 0,
			repositories: [],
		});
		expect(catalog).toMatchObject({
			status: "no_installations",
			installUrl: "https://github.com/apps/ytimesy/installations/new",
		});
	});

	it("reports an empty grant instead of inventing repositories", () => {
		const catalog = gitHubProjectCatalog({
			credentialsPresent: true,
			installUrl: "https://github.com/apps/ytimesy/installations/new",
			installationCount: 1,
			repositories: [],
		});
		expect(catalog.status).toBe("no_repositories");
		expect(catalogStatusCopy(catalog)).toBe(
			"No repositories granted to the GitHub App.",
		);
	});

	it("lists authorized repositories", () => {
		const catalog = gitHubProjectCatalog({
			credentialsPresent: true,
			installUrl: null,
			installationCount: 1,
			repositories: [ytimesy],
		});
		expect(catalog.status).toBe("ready");
		if (catalog.status !== "ready") return;
		expect(catalog.projects).toHaveLength(1);
		expect(catalog.projects[0]?.projectId).toBe("github:y-times-y/ytimesy");
	});
});

describe("project selection", () => {
	const listed = gitHubProjectCatalog({
		credentialsPresent: true,
		installUrl: null,
		installationCount: 1,
		repositories: [ytimesy],
	});
	const projects = listed.status === "ready" ? listed.projects : [];

	it("restores a saved authorized project", () => {
		expect(
			resolveSelectedProject({
				projects,
				saved: {
					projectId: githubProjectId("y-times-y/ytimesy"),
					branch: "cursor/cloud-session-ux-58b4",
				},
			}),
		).toEqual({
			projectId: "github:y-times-y/ytimesy",
			branch: "cursor/cloud-session-ux-58b4",
		});
	});

	it("selects the only authorized repository when nothing is saved", () => {
		expect(resolveSelectedProject({ projects, saved: null })).toEqual({
			projectId: "github:y-times-y/ytimesy",
			branch: "master",
		});
	});

	it("drops a saved project that the App can no longer access", () => {
		expect(
			resolveSelectedProject({
				projects: [],
				saved: {
					projectId: githubProjectId("y-times-y/ytimesy"),
					branch: "master",
				},
			}),
		).toBeNull();
	});

	it("keeps default branch in the picker and replaces a missing saved branch", () => {
		const branches = branchesForPicker(["feature"], "master");
		expect(branches).toEqual(["master", "feature"]);
		expect(
			resolveSelectedBranch(
				{
					projectId: githubProjectId("y-times-y/ytimesy"),
					branch: "gone",
				},
				branches,
				"master",
			),
		).toBe("master");
	});

	it("persists auto-selection and cleared unauthorized saves", () => {
		expect(
			selectionNeedsPersist(null, {
				projectId: githubProjectId("y-times-y/ytimesy"),
				branch: "master",
			}),
		).toBe(true);
		expect(
			selectionNeedsPersist(
				{
					projectId: githubProjectId("y-times-y/ytimesy"),
					branch: "master",
				},
				null,
			),
		).toBe(true);
		expect(
			selectionNeedsPersist(
				{
					projectId: githubProjectId("y-times-y/ytimesy"),
					branch: "master",
				},
				{
					projectId: githubProjectId("y-times-y/ytimesy"),
					branch: "master",
				},
			),
		).toBe(false);
	});
});

describe("publicProjectPicker", () => {
	it("serializes a ready catalog for the UI", () => {
		const catalog = gitHubProjectCatalog({
			credentialsPresent: true,
			installUrl: githubAppInstallUrl("ytimesy"),
			installationCount: 1,
			repositories: [ytimesy],
		});
		expect(
			publicProjectPicker({
				catalog,
				selected: {
					projectId: githubProjectId("y-times-y/ytimesy"),
					branch: "master",
				},
				branches: ["master"],
			}),
		).toEqual({
			status: "ready",
			projects: [
				{
					projectId: "github:y-times-y/ytimesy",
					fullName: "y-times-y/ytimesy",
					defaultBranch: "master",
					private: true,
				},
			],
			selectedProjectId: "github:y-times-y/ytimesy",
			selectedBranch: "master",
			branches: ["master"],
			installUrl: "https://github.com/apps/ytimesy/installations/new",
			message: null,
		});
	});
});
