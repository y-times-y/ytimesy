import type { ModelMessage } from "ai";
import {
	MAIN_MENTION_ID,
	mentionedAgentNames,
	mentionNote,
} from "#/domain/agent-mentions";
import { isUserRequestMessage } from "#/domain/api-conversation";
import { helperName, MAIN_NAME } from "#/domain/helper-names";
import type { SessionItem } from "#/domain/session-item";
import { type SubagentNode, subagentTree } from "#/domain/subagent-tree";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	descendantAgentSessions,
} from "../adapters/agent-sessions";

export type MentionDeps = {
	readonly session: (
		userId: string,
		sessionId: string,
	) => Promise<AgentSessionRecord | null>;
	readonly descendants: (
		userId: string,
		rootId: string,
	) => Promise<readonly AgentSessionRecord[]>;
	readonly now: () => number;
};

// Read at call time: a message without a helper mention reads nothing.
const liveDeps: MentionDeps = {
	session: (userId, sessionId) => agentSessionForOwner(userId, sessionId),
	descendants: (userId, rootId) => descendantAgentSessions(userId, rootId),
	now: () => Date.now(),
};

/**
 * Who a message's @mentions name, for the agent it is sent to (`self`: null
 * for the lead, else that helper's session id): each other helper's agent
 * id (the id agent_send takes), role, state and task, and Main as the lead.
 * The recipient's own name is no mention.
 */
export function mentionNoteFromTree(
	text: string,
	nodes: readonly SubagentNode[],
	self: string | null,
): string | null {
	return mentionNote(
		mentionedAgentNames(text).flatMap((name) => {
			if (name === MAIN_MENTION_ID)
				return self ? [{ name: MAIN_NAME, is: "the lead agent" }] : [];
			const node = nodes.find((entry) => entry.shortName === name);
			return node && node.id !== self
				? [
						{
							name,
							is: `agent ${node.label} (${node.role}, ${node.state}, "${helperName(node.title)}")`,
						},
					]
				: [];
		}),
	);
}

/**
 * The lead's note for a message to a root chat that @mentions its helpers
 * ("@build-1"), so it knows which one is meant and can reach it with
 * agent_send. Null without such a mention (no reads then) or outside a
 * root chat.
 */
export async function mentionNoteFor(
	userId: string,
	rootSessionId: string,
	text: string,
	deps: MentionDeps = liveDeps,
): Promise<string | null> {
	if (!mentionedAgentNames(text).some((name) => name !== MAIN_MENTION_ID))
		return null;
	const root = await deps.session(userId, rootSessionId);
	if (!root || root.parentSessionId) return null;
	const helpers = (await deps.descendants(userId, root.id)).filter(
		(session) => session.agentRole && session.userId === userId,
	);
	return mentionNoteFromTree(
		text,
		subagentTree(root.id, [root, ...helpers], deps.now()).nodes,
		null,
	);
}

/**
 * A turn's model input with the mention note after the person's request.
 * Only a turn the request itself started (its input ends with it): a turn
 * a helper's report wakes reads that report instead.
 */
export async function withMentionNote(
	input: {
		readonly userId: string;
		readonly session: {
			readonly id: string;
			readonly parentSessionId: string | null;
		};
		readonly items: readonly SessionItem[];
		readonly messages: ModelMessage[];
	},
	deps: MentionDeps = liveDeps,
): Promise<ModelMessage[]> {
	if (input.session.parentSessionId) return input.messages;
	const last = input.messages.at(-1);
	const request = [...input.items]
		.reverse()
		.find((item) => item.kind === "userMessage");
	if (
		!last ||
		request?.kind !== "userMessage" ||
		!isUserRequestMessage(input.items, last)
	)
		return input.messages;
	const note = await mentionNoteFor(
		input.userId,
		input.session.id,
		request.text,
		deps,
	);
	return note
		? [...input.messages, { role: "user", content: note }]
		: input.messages;
}
