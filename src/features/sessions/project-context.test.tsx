import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Project } from "#/domain/projects";
import { BaseBranchPicker } from "./base-branch-picker";
import { ProjectContext } from "./project-context";

// The menu renders inline so its rows can be checked without a browser.
vi.mock("#/components/ui/popover", () => ({
	Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	PopoverTrigger: ({
		children,
		...props
	}: {
		children: ReactNode;
		className?: string;
		"aria-label"?: string;
	}) => (
		<button type="button" {...props}>
			{children}
		</button>
	),
	PopoverContent: ({ children }: { children: ReactNode }) => (
		<div data-menu="">{children}</div>
	),
}));

const project: Project = {
	id: "project",
	fullName: "owner/repo",
	installationId: 1,
	repositoryId: 2,
	branch: "main",
};

function render(node: ReactNode, branches?: readonly string[]) {
	const client = new QueryClient();
	client.setQueryData(["workspace", "project"], { status: "ready" });
	if (branches)
		client.setQueryData(["github", "branches", 1, 2], {
			branches,
			defaultBranch: "main",
		});
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>{node}</QueryClientProvider>,
	);
}

it("offers a new chat's base branch, defaulting to the default branch", () => {
	const html = render(
		<BaseBranchPicker project={project} value={null} onChange={() => {}} />,
		["main", "develop", "release/2.1"],
	);
	expect(html).toContain('aria-label="Start from main"');
	expect(html).toContain(">from<");
	expect(html).toContain('placeholder="Search branches"');
	// Default first, marked, and selected.
	expect(html.indexOf(">main<")).toBeLessThan(html.indexOf(">develop<"));
	expect(html.indexOf(">develop<")).toBeLessThan(html.indexOf(">release/2.1<"));
	expect(html).toContain(">Default<");
	expect(html).toMatch(/aria-selected="true"[^>]*title="main"/);
	expect(html).toMatch(/aria-selected="false"[^>]*title="develop"/);
});

it("shows the picked branch on the trigger and as selected", () => {
	const html = render(
		<BaseBranchPicker project={project} value="develop" onChange={() => {}} />,
		["main", "develop"],
	);
	expect(html).toContain('aria-label="Start from develop"');
	expect(html).toMatch(/aria-selected="true"[^>]*title="develop"/);
});

it("shows loading rows before the branches arrive", () => {
	const html = render(
		<BaseBranchPicker project={project} value={null} onChange={() => {}} />,
	);
	expect(html).toContain('aria-label="Start from main"');
	expect(html).toContain('aria-busy="true"');
});

it("shows a started chat's current branch read-only", () => {
	const html = render(
		<BaseBranchPicker
			project={project}
			value={null}
			onChange={() => {}}
			currentBranch="agent/hotfix"
			locked
		/>,
		["main"],
	);
	expect(html).toContain('title="Branch agent/hotfix"');
	expect(html).toContain(">agent/hotfix<");
	expect(html).not.toContain(">from<");
	expect(html).not.toContain("<button");
});

it("is hidden without a repository", () => {
	expect(
		render(
			<BaseBranchPicker
				project={{ ...project, fullName: "", repositoryId: 0 }}
				value={null}
				onChange={() => {}}
			/>,
		),
	).toBe("");
	expect(render(<BaseBranchPicker value={null} onChange={() => {}} />)).toBe(
		"",
	);
});

it("keeps workspace status and shows the chat's branch once it has started", () => {
	const html = render(
		<ProjectContext
			projects={[]}
			selectedProject={project}
			onSelectProject={() => {}}
			projectLocked
			currentBranch="ytimesy/fix-parser-0c4a1e"
			onBaseBranchChange={() => {}}
		/>,
	);
	expect(html).toContain(">ytimesy/fix-parser-0c4a1e<");
	expect(html).not.toContain("Start from");
});

it("shows no branch or base picker for a chat without a branch (Y²)", () => {
	for (const projectLocked of [true, false]) {
		const html = render(
			<ProjectContext
				projects={[project]}
				selectedProject={project}
				onSelectProject={() => {}}
				projectLocked={projectLocked}
				currentBranch="ytimesy/hey-what-is-the-other-f1c8fe"
				onBaseBranchChange={() => {}}
				branchless
			/>,
		);
		expect(html).not.toContain("ytimesy/hey-what-is-the-other-f1c8fe");
		expect(html).not.toContain("base-branch");
	}
});

it("offers the base picker beside the project in a new chat", () => {
	const html = render(
		<ProjectContext
			projects={[project]}
			selectedProject={project}
			onSelectProject={() => {}}
			baseBranch="develop"
			onBaseBranchChange={() => {}}
		/>,
		["main", "develop"],
	);
	expect(html).toContain('aria-label="Project"');
	expect(html).toContain('aria-label="Start from develop"');
});

it("draws the repository picker as the one call to action before the first project", () => {
	const html = render(
		<ProjectContext
			projects={[]}
			onSelectProject={() => {}}
			onBaseBranchChange={() => {}}
		/>,
	);
	expect(html).toMatch(/class="session-context" data-empty="true"/);
	expect(html).toMatch(
		/aria-label="Project" data-empty="true" title="Add repository"/,
	);
	expect(html).toContain(">Add repository<");
	expect(html).not.toContain("Select project");
	// With a project, the picker is the usual quiet label.
	const withProject = render(
		<ProjectContext
			projects={[project]}
			selectedProject={project}
			onSelectProject={() => {}}
		/>,
	);
	expect(withProject).not.toContain("data-empty");
	expect(withProject).not.toContain("Add repository");
});
