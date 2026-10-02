import { describe, expect, it } from "vitest";
import {
	addedProjectBranch,
	addProjectCopy,
	addProjectPhase,
	filterRepositories,
	projectPickerLists,
	projectPickerRows,
	repositoryChoiceValue,
	repositoryIsAdded,
	scratchRepositoryName,
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

	it("lets the composer picker add a GitHub repo that is not a project yet", () => {
		const ytimesy = {
			installationId: 1,
			repositoryId: 11,
			fullName: "y-times-y/ytimesy",
			defaultBranch: "master",
		};
		const notes = {
			installationId: 1,
			repositoryId: 12,
			fullName: "het/notes",
			defaultBranch: "main",
		};
		expect(
			repositoryIsAdded([{ installationId: 1, repositoryId: 11 }], notes),
		).toBe(false);
		expect(
			projectPickerLists({
				projects: [{ ...ytimesy, id: "p1", branch: "ytimesy/ytimesy-000b" }],
				repositories: [ytimesy, notes],
				query: "",
			}),
		).toEqual({
			added: [{ ...ytimesy, id: "p1", branch: "ytimesy/ytimesy-000b" }],
			available: [notes],
		});
		expect(
			projectPickerRows({
				projects: [{ ...ytimesy, id: "p1", branch: "ytimesy/ytimesy-000b" }],
				repositories: [ytimesy, notes],
				query: "",
				selectedProjectId: "p1",
			}),
		).toEqual([
			{
				key: "1:12",
				fullName: "het/notes",
				selected: false,
				project: undefined,
				repository: notes,
			},
			{
				key: "1:11",
				fullName: "y-times-y/ytimesy",
				selected: true,
				project: { ...ytimesy, id: "p1", branch: "ytimesy/ytimesy-000b" },
				repository: ytimesy,
			},
		]);
		expect(scratchRepositoryName("  New_App.1 ")).toBe("New_App.1");
		expect(scratchRepositoryName("bad name")).toBe(null);
	});
});
