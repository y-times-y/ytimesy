import {
	type AgentIcon,
	agentColor,
	type HelperIdentity,
	KIND_ICONS,
	KIND_TAGS,
	MAIN_NAME,
} from "./helper-names";

/**
 * @mentions in the composer: the user types "@" and picks one of the chat's
 * other agents (Main or a helper by its short name, "@build-1"); the agent
 * whose composer it is never appears, as it is the one being written to.
 * The sent message shows each mention as a chip, and its recipient reads
 * which agent is meant (mentionNote). Pure rules; the popover is
 * mention-popover.tsx.
 */

export type MentionAgent = {
	/** The helper's session id; Main's is "main". */
	readonly id: string;
	/** "Main", "build-1". */
	readonly name: string;
	readonly task?: string;
	readonly icon: AgentIcon;
	readonly color: string;
};

export const MAIN_MENTION_ID = "main";

/**
 * The agents one can mention while writing to `self` (MAIN_MENTION_ID or a
 * helper's id): Main, then the chat's helpers in start order
 * (helperIdentitiesOf), never `self`.
 */
export function mentionAgents(
	identities: ReadonlyMap<
		string,
		Pick<HelperIdentity, "name" | "task" | "icon" | "color">
	>,
	self: string,
): MentionAgent[] {
	const agents: MentionAgent[] = [
		{
			id: MAIN_MENTION_ID,
			name: MAIN_NAME,
			icon: KIND_ICONS.main,
			color: agentColor("main"),
		},
		...[...identities].map(([id, identity]) => ({
			id,
			name: identity.name,
			task: identity.task,
			icon: identity.icon,
			color: identity.color,
		})),
	];
	return agents.filter((agent) => agent.id !== self);
}

/** The "@query" being typed at the caret: where its "@" is and what follows. */
export function activeMention(
	text: string,
	caret: number,
): { readonly start: number; readonly query: string } | null {
	const match = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
	if (!match) return null;
	// Not inside a word: "@bu|ild" picks nothing.
	if (/[\w-]/.test(text.charAt(caret))) return null;
	return {
		start: match.index + (match[1] ?? "").length,
		query: match[2] ?? "",
	};
}

/** The agents a query names: name prefixes first, then names or tasks containing it. */
export function mentionMatches(
	agents: readonly MentionAgent[],
	query: string,
): MentionAgent[] {
	const needle = query.toLowerCase();
	if (!needle) return [...agents];
	const prefix = agents.filter((agent) =>
		agent.name.toLowerCase().startsWith(needle),
	);
	const rest = agents.filter(
		(agent) =>
			!prefix.includes(agent) &&
			(agent.name.toLowerCase().includes(needle) ||
				agent.task?.toLowerCase().includes(needle)),
	);
	return [...prefix, ...rest];
}

/** The draft with the typed "@query" replaced by "@name ", and the caret after it. */
export function insertMention(
	text: string,
	mention: { readonly start: number },
	caret: number,
	name: string,
): { readonly text: string; readonly caret: number } {
	const after = text.slice(caret);
	const inserted = `@${name}${after.startsWith(" ") ? "" : " "}`;
	return {
		text: `${text.slice(0, mention.start)}${inserted}${after}`,
		caret: mention.start + inserted.length + (after.startsWith(" ") ? 1 : 0),
	};
}

const HELPER_TAGS = [
	...new Set(
		Object.values(KIND_TAGS)
			.filter((tag): tag is string => tag !== null && tag !== "Background")
			.map((tag) => tag.toLowerCase()),
	),
];
const HELPER_NAME = new RegExp(`^(?:${HELPER_TAGS.join("|")})-\\d+$`);
const MENTION = /(^|[\s(])@([A-Za-z][\w-]*)(?![\w-])/g;

/** Each mention of a known agent, by its name as typed ("build-1", "Main"). */
export type MentionSegment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "mention"; readonly name: string };

/** A message split into text and mentions of the names `known` accepts. */
export function mentionSegments(
	text: string,
	known: (name: string) => boolean,
): MentionSegment[] {
	const segments: MentionSegment[] = [];
	let at = 0;
	for (const match of text.matchAll(MENTION)) {
		const name = match[2] ?? "";
		if (!known(name)) continue;
		const start = (match.index ?? 0) + (match[1] ?? "").length;
		if (start > at)
			segments.push({ kind: "text", text: text.slice(at, start) });
		segments.push({ kind: "mention", name });
		at = start + name.length + 1;
	}
	if (at < text.length) segments.push({ kind: "text", text: text.slice(at) });
	return segments;
}

/** The agent names a message mentions ("main", "build-1"), lowercased, once each, in order. */
export function mentionedAgentNames(text: string): string[] {
	const names = mentionSegments(text, (name) => {
		const lower = name.toLowerCase();
		return lower === MAIN_MENTION_ID || HELPER_NAME.test(lower);
	}).flatMap((segment) =>
		segment.kind === "mention" ? [segment.name.toLowerCase()] : [],
	);
	return [...new Set(names)];
}

const NOTE_OPEN = "[@mentions in the user's message: ";

/** A queued message's model text without the mention note it carries last. */
export function withoutMentionNote(text: string) {
	const at = text.lastIndexOf(`\n\n${NOTE_OPEN}`);
	return at >= 0 && text.endsWith("]") && !text.slice(at + 2).includes("\n")
		? text.slice(0, at)
		: text;
}

/**
 * What an agent reads beside a message that mentions others: who each one
 * is ("agent 1 (writer, working, \"Fix pricing rounding\")", "the lead").
 * Null when no mention names another agent of the chat.
 */
export function mentionNote(
	mentions: readonly { readonly name: string; readonly is: string }[],
): string | null {
	if (!mentions.length) return null;
	return `${NOTE_OPEN}${mentions
		.map((mention) => `@${mention.name} = ${mention.is}`)
		.join("; ")}]`;
}

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An agent's reply split into prose and the known agent names it writes
 * ("build-1", "@research-2", "Main"): exact, case-sensitive whole words,
 * never part of a path, URL, address or longer name.
 */
/**
 * The length of a quoted task right after an agent's name, as models echo
 * the report header: ' ("Audit chat lifecycle")' or ' (“Audit chat lifecycle”)'.
 */
export function echoedTaskLength(after: string): number {
	return (
		/^\s*\(\s*[“"‘'][^()\n]{1,160}?[”"’']\s*\)/.exec(after)?.[0].length ?? 0
	);
}

export function agentNameSegments(
	text: string,
	names: ReadonlySet<string>,
): MentionSegment[] {
	if (!names.size) return [{ kind: "text", text }];
	const pattern = new RegExp(
		`(^|[^\\w@/.:-])(@?)(${[...names]
			.sort((left, right) => right.length - left.length)
			.map(escapeRegExp)
			.join("|")})(?![\\w-]|[./:@]\\w)`,
		"g",
	);
	const segments: MentionSegment[] = [];
	let at = 0;
	for (const match of text.matchAll(pattern)) {
		const start = (match.index ?? 0) + (match[1] ?? "").length;
		const name = match[3] ?? "";
		if (start > at)
			segments.push({ kind: "text", text: text.slice(at, start) });
		segments.push({ kind: "mention", name });
		at = start + (match[2] ?? "").length + name.length;
		// The chip names the agent; a quoted task right after it repeats it.
		at += echoedTaskLength(text.slice(at));
	}
	if (at === 0) return [{ kind: "text", text }];
	if (at < text.length) segments.push({ kind: "text", text: text.slice(at) });
	return segments;
}

/** Inline code that is exactly a known agent name ("build-1", "@build-1"). */
export function agentNameInCode(
	code: string,
	names: ReadonlySet<string>,
): string | null {
	const name = code.trim().replace(/^@/, "");
	return names.has(name) ? name : null;
}
