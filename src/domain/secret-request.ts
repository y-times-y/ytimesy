import type { SessionItem } from "./session-item";

/**
 * The agent asks the user for a project secret with this tool; the turn ends and
 * the chat shows a field where the user pastes the value. The value goes straight
 * to project settings, never through the model or the transcript.
 */
export const REQUEST_PROJECT_SECRET_TOOL = "request_project_secret";

/** Kinds the agent can ask for; build secrets only reach environment setup. */
export const REQUESTABLE_SECRET_KINDS = ["runtime", "environment"] as const;
export type RequestableSecretKind = (typeof REQUESTABLE_SECRET_KINDS)[number];

export const SECRET_REASON_LIMIT = 300;

/** What the user's reply says once the value is saved; the next turn sees the variable. */
export function secretProvidedText(name: string) {
	return `I saved ${name} to the project's secrets. Continue.`;
}

export function secretDeclinedText(name: string) {
	return `I won't add ${name}. Continue without it.`;
}

/** How a secret request was answered, from the transcript alone. */
export function secretRequestOutcome(
	items: readonly SessionItem[],
	requestId: SessionItem["id"],
): "pending" | "provided" | "answered" {
	const index = items.findIndex((item) => item.id === requestId);
	const request = items[index];
	if (index < 0 || request?.kind !== "secretRequest") return "answered";
	const reply = items
		.slice(index + 1)
		.find((item) => item.kind === "userMessage");
	if (!reply) return "pending";
	return reply.kind === "userMessage" &&
		reply.text === secretProvidedText(request.name)
		? "provided"
		: "answered";
}
