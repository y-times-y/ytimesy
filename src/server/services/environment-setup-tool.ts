import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { environmentRecipe } from "#/domain/project-environment";
import { saveProjectEnvironment } from "./project-environment-setup";

export const SAVE_PROJECT_ENVIRONMENT_TOOL = "save_project_environment";

/**
 * Lets the agent save how this project's machine is set up, once it has got
 * the project running: the install command, background services and checks.
 * It goes to Settings > Project > Environment and the machine image rebuilds
 * from it, so new chats start ready.
 */
export function environmentSetupTools(context: {
	readonly userId: string;
	readonly projectId: string;
}): ToolSet {
	return {
		[SAVE_PROJECT_ENVIRONMENT_TOOL]: tool({
			description: `Save this project's environment setup after you have verified it on this machine: the command that installs dependencies on a fresh clone, any long-running services the app needs (with the port each listens on) and the commands that check the code. It is saved in the project's settings and the project's machine image is rebuilt from it in the background, so every new chat starts with dependencies installed. Use it when the user asks you to set up the environment, or after you had to fix a broken setup. Run every command yourself first; save only what worked. Secrets are not part of it: ask for missing ones with request_project_secret and name the ones install needs in buildSecrets.`,
			inputSchema: z.object({
				repository: z
					.string()
					.optional()
					.describe(
						"owner/name of the repository this setup is for; required when the project has more than one.",
					),
				install: z
					.string()
					.optional()
					.describe(
						"Shell command run in the repository root on a fresh clone, e.g. 'corepack pnpm install --frozen-lockfile'.",
					),
				services: z
					.array(
						z.object({
							name: z.string().describe("Short name, e.g. web or db."),
							command: z.string(),
							port: z.number().int(),
						}),
					)
					.optional()
					.describe(
						"Processes started in the background, ready once the port listens.",
					),
				checks: z
					.array(z.string())
					.optional()
					.describe("Commands that check the code, e.g. tests and typecheck."),
				buildSecrets: z
					.array(z.string())
					.optional()
					.describe("Project secrets the install command needs (names only)."),
				summary: z
					.string()
					.max(300)
					.describe("One sentence the user sees: what this setup does."),
			}),
			execute: async ({ repository, summary, ...rest }) => {
				const recipe = environmentRecipe.safeParse(rest);
				if (!recipe.success)
					return {
						saved: false,
						error: recipe.error.issues
							.map(
								(issue) =>
									`${issue.path.join(".") || "setup"}: ${issue.message}`,
							)
							.join("; "),
					};
				try {
					const result = await saveProjectEnvironment({
						userId: context.userId,
						projectId: context.projectId,
						repository,
						recipe: recipe.data,
						source: "agent",
						summary,
					});
					return {
						saved: true,
						repository: result.repository,
						note: result.rebuilding
							? "Saved. The project's machine image is rebuilding from it in the background; new chats use it once it is ready."
							: "Saved. It is used the next time the project's machine image is built.",
					};
				} catch (cause) {
					return {
						saved: false,
						error:
							cause instanceof Error ? cause.message : "Could not save it.",
					};
				}
			},
		}),
	};
}
