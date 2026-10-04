import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProjectContext } from "./project-context";

it("keeps workspace status without offering branch switching", () => {
	const client = new QueryClient();
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
	expect(html).not.toContain('aria-label="Branch"');
	expect(html).not.toContain("branch-select");
});
