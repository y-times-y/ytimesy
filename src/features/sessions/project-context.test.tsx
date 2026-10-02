import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProjectContext } from "./project-context";

vi.mock("#/components/ui/select", () => ({
	Select: ({
		value,
		disabled,
		children,
	}: {
		value: string;
		disabled: boolean;
		children: ReactNode;
	}) => (
		<div data-disabled={disabled}>
			<span>{value}</span>
			{children}
		</div>
	),
	SelectContent: () => null,
	SelectItem: () => null,
	SelectTrigger: () => null,
	SelectValue: () => null,
}));

it("shows the selected branch verbatim before submission", () => {
	const client = new QueryClient();
	client.setQueryData(["github", "branches", 1, 2], {
		branches: ["main", "feature"],
		defaultBranch: "main",
	});
	client.setQueryData(["workspace", "project"], { status: "ready" });
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<ProjectContext
				projects={[]}
				selectedProject={{
					id: "project",
					fullName: "owner/repo",
					installationId: 1,
					repositoryId: 2,
					branch: "main",
				}}
				onSelectProject={() => {}}
				projectLocked
			/>
		</QueryClientProvider>,
	);
	expect(html).toContain(">main<");
	expect(html).not.toContain("ytimesy/repo-");
	expect(html).toContain('data-disabled="false"');
});
