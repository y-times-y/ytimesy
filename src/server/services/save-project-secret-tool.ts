import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { parseProjectSecretName } from "#/domain/project-secret";
import { REQUESTABLE_SECRET_KINDS } from "#/domain/secret-request";

export const SECRET_SCOPES = ["project", "account"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

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
		scope: SecretScope;
	}) => Promise<void>;
}): ToolSet {
	return {
		[SAVE_PROJECT_SECRET_TOOL]: tool({
			description:
				"Save a credential you now hold as a project secret, so every other chat in this project has it as an environment variable without the user doing the sign-in again. Use it after the user approved access and you signed in with a CLI or obtained a token. Give a command whose output is exactly the value, for example `fly auth token`; it runs in the workspace and the output is saved without you seeing it. Never use it for GitHub: GitHub is already connected through ytimesy. Never pass the value itself. Saving replaces a secret of the same name. Always ask the user first with ask_user, and only call this once they say yes: offer 'this project only', 'all my projects' and 'do not save'. Use scope \"project\" or \"account\" to match their answer; an account secret reaches every project they own.",
			inputSchema: z.object({
				name: z.string().describe("Environment variable name, e.g. FLY_API_TOKEN."),
				valueCommand: z
					.string()
					.min(1)
					.max(2_000)
					.describe("Shell command whose stdout is the secret value."),
				kind: z.enum(REQUESTABLE_SECRET_KINDS).default("runtime"),
				scope: z
					.enum(SECRET_SCOPES)
					.describe("What the user chose when you asked."),
			}),
			execute: async ({ name, valueCommand, kind, scope }) => {
				const parsed = parseProjectSecretName(name);
				const ran = await input.runInWorkspace(valueCommand);
				const value = ran.stdout.trim();
				if (ran.exitCode !== 0 || !value)
					return {
						saved: false,
						error: "The command did not print a value; nothing was saved.",
					};
				try {
					await input.save({ name: parsed, kind, value, scope });
				} catch (error) {
					return {
						saved: false,
						error: error instanceof Error ? error.message : "Not saved.",
					};
				}
				return {
					saved: true,
					name: parsed,
					note: `Saved ${scope === "account" ? "for all the user's projects" : "to this project"}; new chats have it as an environment variable.`,
				};
			},
		}),
	};
}
