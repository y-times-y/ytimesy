import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import {
	parseGitHubProjectId,
	type SelectedGitHubProject,
} from "#/domain/github-project";
import { ProjectId } from "#/domain/ids";

export const SELECTED_PROJECT_PATH = ".ytimesy/selected-project.json";

export async function readSelectedProject(): Promise<SelectedGitHubProject | null> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(SELECTED_PROJECT_PATH, "utf8"),
		);
		if (!isStoredSelection(parsed)) return null;
		const projectId = ProjectId(parsed.projectId);
		if (!parseGitHubProjectId(projectId)) return null;
		return { projectId, branch: parsed.branch.trim() };
	} catch {
		return null;
	}
}

export async function writeSelectedProject(
	selection: SelectedGitHubProject,
): Promise<void> {
	if (!parseGitHubProjectId(selection.projectId)) {
		throw new Error("Select a GitHub repository.");
	}
	const branch = selection.branch.trim();
	if (!branch) throw new Error("A branch is required.");
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(
		SELECTED_PROJECT_PATH,
		`${JSON.stringify({ projectId: selection.projectId, branch }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

export async function clearSelectedProject(): Promise<void> {
	try {
		await unlink(SELECTED_PROJECT_PATH);
	} catch {
		return;
	}
}

function isStoredSelection(
	value: unknown,
): value is { projectId: string; branch: string } {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as { projectId?: unknown; branch?: unknown };
	return (
		typeof entry.projectId === "string" &&
		entry.projectId.startsWith("github:") &&
		typeof entry.branch === "string" &&
		entry.branch.trim().length > 0
	);
}
