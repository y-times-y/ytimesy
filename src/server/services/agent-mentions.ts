import type { ModelMessage } from "ai";
import { mentionedHelperNames, mentionNote } from "#/domain/agent-mentions";
import { isUserRequestMessage } from "#/domain/api-conversation";
import { helperName } from "#/domain/helper-names";
import type { SessionItem } from "#/domain/session-item";
import { subagentTree } from "#/domain/subagent-tree";
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
 * The lead's note for a message to a root chat that @mentions its helpers
 * ("@build-1"): each mentioned helper's agent id, role, state and task, so
 * the lead knows which one is meant and can reach it with agent_send. Null
 * without such a mention (no reads then) or outside a root chat.
 */
export async function mentionNoteFor(
	userId: string,
	rootSessionId: string,
	text: string,
	deps: MentionDeps = liveDeps,
): Promise<string | null> {
	const names = mentionedHelperNames(text);
	if (!names.length) return null;
	const root = await deps.session(userId, rootSessionId);
	if (!root || root.parentSessionId) return null;
	const helpers = (await deps.descendants(userId, root.id)).filter(
		(session) => session.agentRole && session.userId === userId,
	);
	const nodes = subagentTree(root.id, [root, ...helpers], deps.now()).nodes;
	return mentionNote(
		names.flatMap((name) => {
			const node = nodes.find((entry) => entry.shortName === name);
			return node
				? [
						{
							name,
							id: node.label,
							role: node.role,
							state: node.state,
							task: helperName(node.title),
						},
					]
				: [];
		}),
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
