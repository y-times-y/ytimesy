import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { parseProjectSecretName } from "#/domain/project-secret";
import {
	REQUEST_PROJECT_SECRET_TOOL,
	REQUESTABLE_SECRET_KINDS,
	SECRET_REASON_LIMIT,
} from "#/domain/secret-request";

/** A successful request ends the turn; the user answers in the chat. */
export const SECRET_REQUEST_END_TURN_TOOLS = [
	REQUEST_PROJECT_SECRET_TOOL,
] as const;

/**
 * Lets the agent ask for a missing project secret. The user pastes the value
 * into the chat card, which saves it to project settings directly; the model
 * only ever learns that the variable is now set.
 */
export function secretRequestTools(existing: readonly string[]): ToolSet {
	return {
		[REQUEST_PROJECT_SECRET_TOOL]: tool({
			description:
				"Ask the user for a credential or configuration value the task needs and the project does not have (for example an API key or database URL). The user pastes it into a field in the chat; it is saved as a project secret and set as an environment variable from your next step on. You never see the value. This ends your turn, so ask only when you cannot proceed without it, and never ask the user to paste secrets into a message.",
			inputSchema: z.object({
				name: z
					.string()
					.describe(
						"Environment variable name: uppercase letters, digits and underscores, e.g. STRIPE_API_KEY.",
					),
				kind: z
					.enum(REQUESTABLE_SECRET_KINDS)
					.default("runtime")
					.describe(
						"runtime (default): value redacted from all output. environment: a non-sensitive setting shown as is.",
					),
				reason: z
					.string()
					.max(SECRET_REASON_LIMIT)
					.describe("One sentence the user sees: what the value is for."),
			}),
			execute: async ({ name, kind, reason }) => {
				const parsed = parseProjectSecretName(name);
				if (existing.includes(parsed))
					return {
						requested: false,
						error: `${parsed} is already a project secret; use "$${parsed}". If its value is wrong, tell the user to update it in project settings.`,
					};
				return { requested: true, name: parsed, kind, reason: reason.trim() };
			},
		}),
	};
}
