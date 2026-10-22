/**
 * Steering a running subagent: agent_send from its parent, or the user
 * writing to it from the chat's agents list. Both reach the subagent as a
 * message at its next model step; this is the wording it reads and the
 * parse the chat uses to show who sent it.
 */

const USER_SENDER = "the user, sent directly from the chat";
const PARENT_NOTE =
	"This is your parent agent steering your brief, not a new user request. Adjust your work accordingly; keep your role's access limits, and put anything you would answer in your final report.";
const USER_NOTE =
	"This is the user steering you directly, not a new brief from your parent. Adjust your work accordingly; keep your role's access limits, and put anything you would answer in your final report.";

/** The longest message the user may send a helper (agent_send's own bound). */
export const HELPER_MESSAGE_MAX = 8_000;

export type SteeringSender =
	| { readonly kind: "parent"; readonly title: string; readonly id: string }
	| { readonly kind: "user" };

/** The transcript text and the model's text (with the role note) for one message. */
export function steeringTexts(input: {
	readonly sender: SteeringSender;
	readonly message: string;
	readonly messageId: string;
}) {
	const from =
		input.sender.kind === "user"
			? USER_SENDER
			: `${input.sender.title} (${input.sender.id})`;
	const text = `Message from ${from}:\n\n${input.message}\n\nCoordination message ID: ${input.messageId}`;
	return {
		text,
		runtimeText: `${text}\n\n${input.sender.kind === "user" ? USER_NOTE : PARENT_NOTE}`,
	};
}

const STEERING =
	/^Message from ([^\n]+):\n\n([\s\S]*?)\n\nCoordination message ID: [^\n]+(?:\n\n[\s\S]*)?$/;

/** Who sent a steering message and its words; null for any other text. */
export function parseSteering(
	text: string,
): { readonly from: "parent" | "user"; readonly text: string } | null {
	const match = STEERING.exec(text);
	if (!match) return null;
	return {
		from: match[1] === USER_SENDER ? "user" : "parent",
		text: match[2] ?? "",
	};
}

/** The lead's note that the user wrote to one of its helpers. */
export function userSteeringNotice(name: string, message: string) {
	const words = message.replace(/\s+/g, " ").trim();
	return `The user sent ${name}: ${words.length > 600 ? `${words.slice(0, 600)}…` : words}`;
}
