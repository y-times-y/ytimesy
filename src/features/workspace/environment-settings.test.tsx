import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { environmentRecipe } from "#/domain/project-environment";
import {
	type WorkspaceView,
	workspaceStatusQuery,
} from "../projects/workspace-status";
import {
	EnvironmentSettings,
	editorStartingRecipe,
	environmentQueryKey,
} from "./environment-settings";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("../projects/environment.fn", () => ({
	getProjectEnvironmentFn: vi.fn(),
	saveProjectEnvironmentFn: vi.fn(),
	restoreProjectEnvironmentFn: vi.fn(),
}));

const text = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ");

function render(workspace: WorkspaceView, repositories: unknown[]) {
	const client = new QueryClient();
	client.setQueryData(workspaceStatusQuery("p").queryKey, workspace);
	client.setQueryData(environmentQueryKey("p"), {
		repositories,
		history: [
			{
				id: "old",
				repositoryId: 1,
				recipe: environmentRecipe.parse({ install: "pnpm i" }),
				source: "agent",
				summary: "First setup",
				savedAt: "2026-10-30T10:00:00.000Z",
				fullName: "org/web",
			},
		],
	});
	return text(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<EnvironmentSettings projectId="p" />
			</QueryClientProvider>,
		),
	);
}

const workspace: WorkspaceView = {
	id: "w",
	projectId: "p",
	status: "ready",
	errorMessage: null,
	updatedAt: "2026-11-01T10:00:00.000Z",
};

it("says what each repository's active build detected instead of assuming a lockfile", () => {
	const html = render(workspace, [
		{
			repositoryId: 1,
			fullName: "org/api",
			saved: null,
			setup: {
				repositoryId: 1,
				fullName: "org/api",
				source: "detected",
				detected: "Python (uv)",
				install: "uv sync --frozen",
			},
		},
		{
			repositoryId: 2,
			fullName: "org/docs",
			saved: null,
			setup: { repositoryId: 2, fullName: "org/docs", source: "none" },
		},
	]);
	expect(html).toContain(
		"Not set up yet: Python (uv), installs with uv sync --frozen.",
	);
	expect(html).toContain("nothing detected");
	expect(html).not.toContain("dependencies install from the lockfile");
});

it("shows a failed rebuild with its reason and Retry, still using the previous setup", () => {
	const html = render(
		{
			...workspace,
			build: {
				id: "b",
				status: "failed",
				rebuild: true,
				startedAt: "2026-11-01T09:00:00.000Z",
				completedAt: "2026-11-01T09:05:00.000Z",
				errorMessage: "Installing dependencies: npm ci failed (exit 1)",
				failure: {
					step: "Installing dependencies",
					command: "npm ci",
					exitCode: 1,
					output: "npm ERR! code ERESOLVE",
				},
			},
		},
		[],
	);
	expect(html).toContain(
		"Last rebuild failed · still using the previous setup",
	);
	expect(html).toContain("Installing dependencies: npm ci failed (exit 1)");
	expect(html).toContain("npm ERR! code ERESOLVE");
	expect(html).toContain("Retry");
});

it("shows a rebuild in progress", () => {
	const html = render(
		{
			...workspace,
			build: {
				id: "b",
				status: "running",
				rebuild: true,
				startedAt: new Date().toISOString(),
				completedAt: null,
				errorMessage: null,
				failure: null,
			},
		},
		[],
	);
	expect(html).toContain("Rebuilding…");
	expect(html).toContain("Details");
});

it("offers to restore an older setup from History", () => {
	const html = render(workspace, [
		{
			repositoryId: 1,
			fullName: "org/web",
			saved: {
				id: "current",
				repositoryId: 1,
				recipe: environmentRecipe.parse({ install: "pnpm i" }),
				source: "user",
				summary: null,
				savedAt: "2026-11-01T10:00:00.000Z",
			},
			setup: null,
		},
	]);
	expect(html).toContain("History (1)");
});

it("starts the Edit box with a valid setup", () => {
	for (const setup of [
		null,
		{
			repositoryId: 1,
			fullName: "org/api",
			source: "detected" as const,
			install: "go mod download",
		},
		{ repositoryId: 1, fullName: "org/api", source: "none" as const },
	]) {
		const start = editorStartingRecipe(undefined, setup);
		expect(environmentRecipe.safeParse(start).success).toBe(true);
	}
	expect(
		editorStartingRecipe(undefined, {
			repositoryId: 1,
			fullName: "org/api",
			source: "detected",
			install: "go mod download",
		}),
	).toMatchObject({ install: "go mod download" });
});
