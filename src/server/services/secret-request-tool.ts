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
const secretReplace = z
	.boolean()
	.describe(
		"Set true to ask for a NEW value of a secret the project already has (it was rotated, expired or is rejected by the service). The card tells the user it replaces the current value. Without it, a name the project already has is not asked for.",
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
				"Ask the user for credentials or configuration values the task needs and the project does not have (for example an API key or database URL). Put every value you need in one call's secrets list: the user sees one card, pastes the ones they have and may skip the rest. Each saved value becomes a project secret and an environment variable from your next step on. Values are redacted from what you see on a best-effort basis. To replace a value the project already has (rotated, expired or rejected), set replace: true on it. This ends your turn, so ask only when you cannot proceed without them, and never ask the user to paste secrets into a message.",
			inputSchema: z.object({
				secrets: z
					.array(
						z.object({
							name: secretName,
							kind: secretKind.default("runtime"),
							reason: secretReason,
							replace: secretReplace.optional(),
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
				replace: secretReplace.optional(),
			}),
			execute: async (input) => {
				const asked = input.secrets ?? [
					{
						name: input.name ?? "",
						kind: input.kind ?? "runtime",
						reason: input.reason ?? "",
						replace: input.replace,
					},
				];
				const secrets = new Map<
					string,
					{
						name: string;
						kind: (typeof asked)[number]["kind"];
						reason: string;
						replace?: true;
					}
				>();
				const alreadySet: string[] = [];
				for (const { name, kind, reason, replace } of asked) {
					const parsed = parseProjectSecretName(name);
					const has = existing.includes(parsed);
					if (has && !replace) alreadySet.push(parsed);
					else if (!secrets.has(parsed))
						secrets.set(parsed, {
							name: parsed,
							kind,
							reason: reason.trim(),
							// Only a name the project has can be replaced.
							...(has ? { replace: true as const } : {}),
						});
				}
				if (!secrets.size)
					return {
						requested: false,
						error: `${alreadySet.join(", ")} ${alreadySet.length === 1 ? "is" : "are"} already set as project secrets; use them as environment variables. If a value is wrong, call this tool again with replace: true for it: the user then pastes a new value that replaces the current one.`,
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
