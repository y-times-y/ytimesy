import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { githubProjectId } from "#/domain/github-project";
import type { GitHubAppListing } from "#/server/adapters/github/octokit-app";
import {
	type GitHubProjectDeps,
	loadGitHubProjectPicker,
	saveGitHubProjectSelection,
} from "./github-projects";

const ytimesy = {
	owner: "y-times-y",
	name: "ytimesy",
	fullName: "y-times-y/ytimesy",
	defaultBranch: "master",
	private: true,
	installationId: "161432829",
};

const credentials = {
	GITHUB_APP_ID: "4932652",
	GITHUB_PRIVATE_KEY:
		"-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
	GITHUB_APP_SLUG: "ytimesy",
};

function memoryStore() {
	let saved: Awaited<ReturnType<GitHubProjectDeps["store"]["read"]>> = null;
	return {
		read: async () => saved,
		write: async (selection: NonNullable<typeof saved>) => {
			saved = selection;
		},
		clear: async () => {
			saved = null;
		},
		get saved() {
			return saved;
		},
	};
}

function listing(options?: {
	installationCount?: number;
	repositories?: (typeof ytimesy)[];
	branches?: string[];
	failList?: string;
}): GitHubAppListing {
	return {
		listAuthorized: async () => {
			if (options?.failList) throw new Error(options.failList);
			return {
				installationCount: options?.installationCount ?? 1,
				repositories: options?.repositories ?? [ytimesy],
			};
		},
		listBranches: async () =>
			options?.branches ?? [
				"master",
				"cursor/workspace-integration-proof-58b4",
			],
	};
}

function deps(overrides?: {
	env?: NodeJS.ProcessEnv;
	github?: GitHubAppListing;
	store?: ReturnType<typeof memoryStore>;
}): GitHubProjectDeps & { store: ReturnType<typeof memoryStore> } {
	const store = overrides?.store ?? memoryStore();
	return {
		env: overrides?.env ?? credentials,
		github: overrides?.github ?? listing(),
		store,
	};
}

describe("loadGitHubProjectPicker", () => {
	it("stays unconfigured without App credentials", async () => {
		const picker = await Effect.runPromise(
			loadGitHubProjectPicker(deps({ env: {} })),
		);
		expect(picker.status).toBe("unconfigured");
		expect(picker.projects).toEqual([]);
		expect(picker.message).toContain("not configured");
	});

	it("selects the only authorized repository and its default branch", async () => {
		const store = memoryStore();
		const picker = await Effect.runPromise(
			loadGitHubProjectPicker(deps({ store })),
		);
		expect(picker.status).toBe("ready");
		expect(picker.projects.map((project) => project.fullName)).toEqual([
			"y-times-y/ytimesy",
		]);
		expect(picker.selectedProjectId).toBe("github:y-times-y/ytimesy");
		expect(picker.selectedBranch).toBe("master");
		expect(picker.branches).toContain("master");
		expect(store.saved).toEqual({
			projectId: "github:y-times-y/ytimesy",
			branch: "master",
		});
	});

	it("surfaces an App request failure without inventing repositories", async () => {
		const picker = await Effect.runPromise(
			loadGitHubProjectPicker(
				deps({ github: listing({ failList: "Bad credentials" }) }),
			),
		);
		expect(picker.status).toBe("failed");
		expect(picker.projects).toEqual([]);
		expect(picker.message).toBe("Bad credentials");
	});

	it("asks to install when the App has no installations", async () => {
		const picker = await Effect.runPromise(
			loadGitHubProjectPicker(
				deps({ github: listing({ installationCount: 0, repositories: [] }) }),
			),
		);
		expect(picker.status).toBe("no_installations");
		expect(picker.installUrl).toBe(
			"https://github.com/apps/ytimesy/installations/new",
		);
	});
});

describe("saveGitHubProjectSelection", () => {
	it("keeps a branch on an authorized repository", async () => {
		const picker = await Effect.runPromise(
			saveGitHubProjectSelection(deps(), {
				projectId: githubProjectId("y-times-y/ytimesy"),
				branch: "cursor/workspace-integration-proof-58b4",
			}),
		);
		expect(picker.selectedBranch).toBe(
			"cursor/workspace-integration-proof-58b4",
		);
	});

	it("rejects a repository the App cannot access", async () => {
		await expect(
			Effect.runPromise(
				saveGitHubProjectSelection(deps(), {
					projectId: githubProjectId("someone/else"),
					branch: "master",
				}),
			),
		).rejects.toThrow("not granted");
	});
});
