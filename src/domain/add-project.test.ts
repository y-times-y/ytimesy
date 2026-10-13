import { describe, expect, it } from "vitest";
import {
	addedProjectBranch,
	addProjectCopy,
	addProjectPhase,
	filterRepositories,
	projectPickerRows,
	projectPickerSections,
	repositoryChoiceValue,
} from "./add-project";

describe("add project", () => {
	it("keeps named projects sharing a primary repository visible and searchable", () => {
		const repository = {
			installationId: 1,
			repositoryId: 11,
			fullName: "org/web",
			defaultBranch: "main",
		};
		const projects = [
			{ ...repository, id: "one", name: "Product one", branch: "main" },
			{
				...repository,
				id: "two",
				name: "Product two",
				branch: "main",
				repositories: [
					{ ...repository, branch: "main" },
					{
						installationId: 1,
						repositoryId: 12,
						fullName: "org/api",
						branch: "main",
					},
				],
			},
		];
		const rows = projectPickerRows({
			projects,
			repositories: [repository],
			query: "",
		});
		expect(
			rows.filter((row) => row.project).map((row) => row.project?.id),
		).toEqual(["one", "two"]);
		expect(
			projectPickerRows({
				projects,
				repositories: [repository],
				query: "org/api",
			}).map((row) => row.project?.id),
		).toEqual(["two"]);
	});
	it("asks to connect GitHub only when it is not ready, then pick a repo", () => {
		expect(
			addProjectPhase({
				loading: true,
				githubReady: false,
			}),
		).toBe("loading");
		expect(
			addProjectPhase({
				loading: false,
				githubReady: false,
			}),
		).toBe("connect");
		expect(
			addProjectPhase({
				loading: false,
				githubReady: true,
			}),
		).toBe("choose");
		expect(addProjectCopy("choose").description).toContain(
			"Select repositories",
		);
	});

	it("keeps the repository default until a chat submits its first task", () => {
		expect(
			addedProjectBranch({
				fullName: "y-times-y/ytimesy",
				repositoryId: 11,
				defaultBranch: "main",
			}),
		).toBe("main");
	});

	it("filters repositories by name and keeps a stable choice value", () => {
		const repositories = [
			{
				installationId: 1,
				repositoryId: 11,
				fullName: "y-times-y/ytimesy",
				defaultBranch: "master",
			},
			{
				installationId: 1,
				repositoryId: 12,
				fullName: "het/notes",
				defaultBranch: "main",
			},
		];
		expect(filterRepositories(repositories, "yti")).toEqual([repositories[0]]);
		expect(repositoryChoiceValue(repositories[0])).toBe("1:11");
		expect(addProjectCopy("connect").title).toBe("Connect GitHub");
	});
});

describe("projectPickerSections", () => {
	it("pins the selected project first and keeps unadded repositories in their own section", () => {
		const project = (id: string, fullName: string, repositoryId: number) =>
			({
				id,
				installationId: 1,
				repositoryId,
				fullName,
				branch: "main",
			}) as never;
		const sections = projectPickerSections({
			projects: [project("a", "acme/alpha", 1), project("z", "zeta/zed", 2)],
			repositories: [
				{
					installationId: 1,
					repositoryId: 1,
					fullName: "acme/alpha",
					defaultBranch: "main",
				},
				{
					installationId: 1,
					repositoryId: 3,
					fullName: "acme/beta",
					defaultBranch: "main",
				},
			],
			query: "",
			selectedProjectId: "z",
		});
		expect(sections.projects.map((row) => row.project?.id)).toEqual(["z", "a"]);
		expect(sections.repositories.map((row) => row.fullName)).toEqual([
			"acme/beta",
		]);
	});
});
