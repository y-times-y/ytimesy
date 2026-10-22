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
 * agents (Main or a helper by its short name, "@build-1"). The sent message
 * shows each mention as a chip, and the lead reads which helper is meant
 * (mentionNote). Pure rules; the popover is mention-popover.tsx.
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

/** Main, then every helper of the chat in start order (helperIdentitiesOf). */
export function mentionAgents(
	identities: ReadonlyMap<
		string,
		Pick<HelperIdentity, "name" | "task" | "icon" | "color">
	>,
): MentionAgent[] {
	return [
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

/** The helper short names a message mentions, once each, in order. */
export function mentionedHelperNames(text: string): string[] {
	const names = mentionSegments(text, (name) =>
		HELPER_NAME.test(name.toLowerCase()),
	).flatMap((segment) =>
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
 * What the lead reads beside a message that mentions helpers: each one's
 * agent id (the id agent_send takes), role, state and task. Null when no
 * mention names a helper of the chat.
 */
export function mentionNote(
	mentions: readonly {
		readonly name: string;
		readonly id: string;
		readonly role: string;
		readonly state: string;
		readonly task: string;
	}[],
): string | null {
	if (!mentions.length) return null;
	return `${NOTE_OPEN}${mentions
		.map(
			(mention) =>
				`@${mention.name} = agent ${mention.id} (${mention.role}, ${mention.state}, "${mention.task}")`,
		)
		.join("; ")}]`;
}
