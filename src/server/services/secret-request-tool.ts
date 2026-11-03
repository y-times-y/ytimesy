import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { parseProjectSecretName } from "#/domain/project-secret";
import {
	REQUEST_PROJECT_SECRET_TOOL,
	REQUESTABLE_SECRET_KINDS,
	SECRET_REASON_LIMIT,
	SECRET_REQUEST_LIMIT,
} from "#/domain/secret-request";

/** A successful request ends the turn; the user answers in the chat. */
export const SECRET_REQUEST_END_TURN_TOOLS = [
	REQUEST_PROJECT_SECRET_TOOL,
] as const;

const secretName = z
	.string()
	.describe(
		"Environment variable name: uppercase letters, digits and underscores, e.g. STRIPE_API_KEY.",
	);
const secretKind = z
	.enum(REQUESTABLE_SECRET_KINDS)
	.describe(
		"runtime (default): value redacted from all output. environment: a non-sensitive setting shown as is.",
	);
const secretReason = z
	.string()
	.max(SECRET_REASON_LIMIT)
	.describe("One short sentence the user sees: what the value is for.");

/**
 * Lets the agent ask for missing project secrets, all in one card. The user
 * pastes the values they have into the card, which saves each to project
 * settings directly, and skips the rest; the model only ever learns which
 * variables are now set. One name alone (name, kind, reason) is the shape
 * older requests used and is still accepted.
 */
export function secretRequestTools(existing: readonly string[]): ToolSet {
	return {
		[REQUEST_PROJECT_SECRET_TOOL]: tool({
			description:
				"Ask the user for credentials or configuration values the task needs and the project does not have (for example an API key or database URL). Put every value you need in one call's secrets list: the user sees one card, pastes the ones they have and may skip the rest. Each saved value becomes a project secret and an environment variable from your next step on. Values are redacted from what you see on a best-effort basis. This ends your turn, so ask only when you cannot proceed without them, and never ask the user to paste secrets into a message.",
			inputSchema: z.object({
				secrets: z
					.array(
						z.object({
							name: secretName,
							kind: secretKind.default("runtime"),
							reason: secretReason,
						}),
					)
					.min(1)
					.max(SECRET_REQUEST_LIMIT)
					.optional()
					.describe("The values to ask for, all in one card."),
				name: secretName
					.optional()
					.describe("Older one-secret form; use secrets instead."),
				kind: secretKind.optional(),
				reason: secretReason.optional(),
			}),
			execute: async (input) => {
				const asked = input.secrets ?? [
					{
						name: input.name ?? "",
						kind: input.kind ?? "runtime",
						reason: input.reason ?? "",
					},
				];
				const secrets = new Map<
					string,
					{ name: string; kind: (typeof asked)[number]["kind"]; reason: string }
				>();
				const alreadySet: string[] = [];
				for (const { name, kind, reason } of asked) {
					const parsed = parseProjectSecretName(name);
					if (existing.includes(parsed)) alreadySet.push(parsed);
					else if (!secrets.has(parsed))
						secrets.set(parsed, {
							name: parsed,
							kind,
							reason: reason.trim(),
						});
				}
				if (!secrets.size)
					return {
						requested: false,
						error: `${alreadySet.join(", ")} ${alreadySet.length === 1 ? "is" : "are"} already set as project secrets; use them as environment variables. If a value is wrong, tell the user to update it in project settings.`,
					};
				return {
					requested: true,
					secrets: [...secrets.values()],
					...(alreadySet.length ? { alreadySet } : {}),
				};
			},
		}),
	};
}
