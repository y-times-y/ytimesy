import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { parseProjectSecretName } from "#/domain/project-secret";
import { REQUESTABLE_SECRET_KINDS } from "#/domain/secret-request";

export const SAVE_PROJECT_SECRET_TOOL = "save_project_secret";

/**
 * Lets the agent keep a credential it was just given access to (a CLI
 * sign-in the user approved, a token a service printed) as a project secret,
 * so the project's other chats have it too. The agent names a command whose
 * output is the value; the server runs it in the workspace and saves the
 * output, so the value never passes through the model or the transcript.
 */
export function saveProjectSecretTools(input: {
	readonly runInWorkspace: (
		command: string,
	) => Promise<{ exitCode: number; stdout: string }>;
	readonly save: (secret: {
		name: string;
		kind: (typeof REQUESTABLE_SECRET_KINDS)[number];
		value: string;
	}) => Promise<void>;
}): ToolSet {
	return {
		[SAVE_PROJECT_SECRET_TOOL]: tool({
			description:
				"Save a credential you now hold as a project secret, so every other chat in this project has it as an environment variable without the user doing the sign-in again. Use it after the user approved access and you signed in with a CLI or obtained a token. Give a command whose output is exactly the value, for example `gh auth token`; it runs in the workspace and the output is saved without you seeing it. Never pass the value itself. Saving replaces a secret of the same name.",
			inputSchema: z.object({
				name: z.string().describe("Environment variable name, e.g. GH_TOKEN."),
				valueCommand: z
					.string()
					.min(1)
					.max(2_000)
					.describe("Shell command whose stdout is the secret value."),
				kind: z.enum(REQUESTABLE_SECRET_KINDS).default("runtime"),
			}),
			execute: async ({ name, valueCommand, kind }) => {
				const parsed = parseProjectSecretName(name);
				const ran = await input.runInWorkspace(valueCommand);
				const value = ran.stdout.trim();
				if (ran.exitCode !== 0 || !value)
					return {
						saved: false,
						error: "The command did not print a value; nothing was saved.",
					};
				try {
					await input.save({ name: parsed, kind, value });
				} catch (error) {
					return {
						saved: false,
						error: error instanceof Error ? error.message : "Not saved.",
					};
				}
				return {
					saved: true,
					name: parsed,
					note: "Saved to the project; new chats have it as an environment variable.",
				};
			},
		}),
	};
}
