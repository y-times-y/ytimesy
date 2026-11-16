import { describe, expect, it } from "vitest";
import type { Project } from "./projects";
import { connectedRepositories, waitingCount } from "./work-items";

const project = (
	id: string,
	repositoryId: number,
	fullName: string,
	extra: Partial<Project> = {},
): Project => ({
	id,
	name: id,
	repositoryId,
	installationId: 1,
	fullName,
	branch: "main",
	...extra,
});

describe("connectedRepositories", () => {
	it("lists each connected repository once, with the first project that has it", () => {
		const repos = connectedRepositories([
			project("a", 1, "acme/web"),
			project("b", 1, "acme/web"),
			project("c", 2, "acme/api"),
		]);
		expect(repos.map((r) => [r.repositoryId, r.name, r.projectId])).toEqual([
			[1, "web", "a"],
			[2, "api", "c"],
		]);
	});
	it("includes every repository of a multi-repository project", () => {
		const repos = connectedRepositories([
			project("a", 1, "acme/web", {
				repositories: [
					{
						repositoryId: 1,
						installationId: 1,
						fullName: "acme/web",
						branch: "main",
					},
					{
						repositoryId: 5,
						installationId: 1,
						fullName: "acme/docs",
						branch: "main",
					},
				],
			}),
		]);
		expect(repos.map((r) => r.name)).toEqual(["web", "docs"]);
	});
	it("names a repository with its owner when another shares its name", () => {
		const repos = connectedRepositories([
			project("a", 1, "acme/app"),
			project("b", 2, "other/app"),
		]);
		expect(repos.map((r) => r.name)).toEqual(["acme/app", "other/app"]);
	});
	it("skips a project without a repository", () => {
		expect(connectedRepositories([project("a", 0, "acme/web")])).toEqual([]);
	});
});

describe("waitingCount", () => {
	it("counts only the rows flagged as waiting, across lists", () => {
		expect(
			waitingCount([
				[{ waiting: true }, { waiting: false }, {}],
				undefined,
				null,
				[{ waiting: true }],
			]),
		).toBe(2);
	});
});
