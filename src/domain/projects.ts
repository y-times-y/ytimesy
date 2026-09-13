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
