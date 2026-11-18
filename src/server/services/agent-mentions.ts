import type { ModelMessage } from "ai";
import {
	MAIN_MENTION_ID,
	mentionedAgentNames,
	mentionedThreads,
	mentionNote,
} from "#/domain/agent-mentions";
import { isUserRequestMessage } from "#/domain/api-conversation";
import { helperName, MAIN_NAME } from "#/domain/helper-names";
import { projectDisplayName } from "#/domain/projects";
import type { SessionItem } from "#/domain/session-item";
import { type SubagentNode, subagentTree } from "#/domain/subagent-tree";
import { threadSlug } from "#/domain/thread-label";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
	descendantAgentSessionMetadata,
} from "../adapters/agent-sessions";
import { database } from "../adapters/database";

/** A chat without its transcript: a mention names helpers, it reads no items. */
type MentionSession = Omit<AgentSessionRecord, "items">;

/** A thread of a project, as a mention reads it. */
export type MentionedThread = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus: string;
	readonly archived: boolean;
	/** The project's display name, which the thread's readable name starts with. */
	readonly projectName: string;
};

export type MentionDeps = {
	readonly session: (
		userId: string,
		sessionId: string,
	) => Promise<MentionSession | null>;
	readonly descendants: (
		userId: string,
		rootId: string,
	) => Promise<readonly MentionSession[]>;
	/** A project's thread by its number; absent in a test that mentions none. */
	readonly thread?: (
		userId: string,
		projectId: string,
		number: number,
	) => Promise<MentionedThread | null>;
	readonly now: () => number;
};

async function threadByNumber(
	userId: string,
	projectId: string,
	number: number,
): Promise<MentionedThread | null> {
	const { rows } = await database().query<{
		id: string;
		title: string;
		turn_status: string | null;
		archived: boolean;
		name: string | null;
		full_name: string;
	}>(
		`select s.id,s.title,s.turn_status,s.archived_at is not null as archived,p.name,p.full_name
		 from agent_session s join project p on p.id=s.project_id
		 where s.user_id=$1 and s.project_id=$2 and s.thread_number=$3
		  and s.parent_session_id is null`,
		[userId, projectId, number],
	);
	const row = rows[0];
	return row
		? {
				id: row.id,
				title: row.title,
				turnStatus: row.turn_status ?? "idle",
				archived: row.archived,
				projectName: projectDisplayName({
					name: row.name ?? undefined,
					fullName: row.full_name,
				}),
			}
		: null;
}

// Read at call time: a message without a helper mention reads nothing.
const liveDeps: MentionDeps = {
	session: (userId, sessionId) =>
		agentSessionMetadataForOwner(userId, sessionId),
	descendants: (userId, rootId) =>
		descendantAgentSessionMetadata(userId, rootId),
	thread: threadByNumber,
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
	threads: readonly { readonly name: string; readonly is: string }[] = [],
): string | null {
	return mentionNote([
		...mentionedAgentNames(text).flatMap((name) => {
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
		...threads,
	]);
}

/** What a thread mention says about its thread: its id (what the thread tools take), state and title. */
function threadMentionIs(thread: MentionedThread) {
	const state = thread.archived
		? "archived"
		: thread.turnStatus === "running"
			? "working"
			: "idle";
	return `thread "${helperName(thread.title)}" (id ${thread.id}, ${state})`;
}

/**
 * The project's threads a message names ("@ytimesy-12"), read as notes. A
 * name counts only when its project part is this project's, so "@alice-2"
 * is just words. Anything unknown is left out.
 */
async function threadMentionNotes(
	userId: string,
	projectId: string,
	text: string,
	skip: ReadonlySet<string>,
	deps: MentionDeps,
): Promise<{ name: string; is: string }[]> {
	if (!deps.thread) return [];
	const notes: { name: string; is: string }[] = [];
	for (const ref of mentionedThreads(text)) {
		if (skip.has(ref.name)) continue;
		const thread = await deps.thread(userId, projectId, ref.number);
		if (!thread || threadSlug(thread.projectName) !== ref.slug) continue;
		notes.push({ name: ref.name, is: threadMentionIs(thread) });
	}
	return notes;
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
	const agentNames = mentionedAgentNames(text).filter(
		(name) => name !== MAIN_MENTION_ID,
	);
	// "@build-1" reads like a thread's name; a message with neither reads nothing.
	if (!agentNames.length && !mentionedThreads(text).length) return null;
	const root = await deps.session(userId, rootSessionId);
	if (!root || root.parentSessionId) return null;
	const helpers = agentNames.length
		? (await deps.descendants(userId, root.id)).filter(
				(session) => session.agentRole && session.userId === userId,
			)
		: [];
	// The note reads each node's name, role, state and title, none of which
	// come from a transcript (only spend and minutes do): no items are read.
	const nodes = subagentTree(
		root.id,
		[root, ...helpers].map((session) => ({ ...session, items: null })),
		deps.now(),
	).nodes;
	// A name that is one of this chat's agents is that agent, not a thread.
	const agents = new Set(
		nodes.flatMap((node) => (node.shortName ? [node.shortName] : [])),
	);
	return mentionNoteFromTree(
		text,
		nodes,
		null,
		await threadMentionNotes(userId, root.projectId, text, agents, deps),
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
