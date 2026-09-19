import { z } from "zod";
export const projectSelection = z.object({
	installationId: z.number().int().positive().safe(),
	repositoryId: z.number().int().positive().safe(),
	branch: z.string().min(1).max(255),
});
export type ProjectSelection = z.infer<typeof projectSelection>;
export interface RepositoryChoice {
	installationId: number;
	repositoryId: number;
	fullName: string;
	defaultBranch: string;
}
export interface Project {
	id: string;
	repositoryId: number;
	installationId: number;
	fullName: string;
	branch: string;
}

export function projectFolderName(fullName: string) {
	const slash = fullName.lastIndexOf("/");
	return slash === -1 ? fullName : fullName.slice(slash + 1);
}

export function selectedProjectIdAfterDelete(input: {
	readonly projects: readonly { readonly id: string }[];
	readonly selectedProjectId: string | undefined;
	readonly deletedProjectId: string;
}): string | undefined {
	if (input.selectedProjectId !== input.deletedProjectId) {
		return input.selectedProjectId;
	}
	return input.projects.find((project) => project.id !== input.deletedProjectId)
		?.id;
}

export function projectMachineRefsToDestroy(input: {
	readonly sessionProviderRefs: readonly (string | null | undefined)[];
	readonly templateProviderRef: string | null | undefined;
}): string[] {
	return [
		...new Set(
			[...input.sessionProviderRefs, input.templateProviderRef].filter(
				(ref): ref is string => Boolean(ref),
			),
		),
	];
}
