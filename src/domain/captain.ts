import { z } from "zod";
import type { SessionTurnStatus } from "./session-item";

/**
 * Captains (docs/captains.md): additional Super agents of a project. Y² stays
 * the project's leader; a captain is a Y²-like chat with a name, a colour, an
 * optional label (a sidebar group) and role instructions. It is data plus one
 * chat: nothing runs for a captain until a message, an @mention or a wake
 * reaches that chat.
 */
export const CAPTAIN_LIMIT = 5;
export const CAPTAIN_NAME_LIMIT = 40;
export const CAPTAIN_LABEL_LIMIT = 24;
export const CAPTAIN_ROLE_LIMIT = 4_000;
export const CAPTAIN_LINE_LIMIT = 200;

/** Provider accents and neutrals: the restrained palette the artifacts use too. */
export const CAPTAIN_COLORS = [
	"#d97757",
	"#34a98a",
	"#5b8def",
	"#7c83ff",
	"#e5a84b",
	"#b7b7b7",
	"#c9ccd1",
	"#8a8f98",
] as const;

export type Captain = {
	readonly id: string;
	readonly projectId: string;
	/** Its own chat (agent_session.chat_role = 'captain'). */
	readonly chatId: string;
	readonly name: string;
	readonly label: string | null;
	readonly color: string;
	readonly rolePrompt: string;
	readonly position: number;
	/** The first line of its last answer, and when (set when a turn settles). */
	readonly lastLine: string | null;
	readonly lastAt: string | null;
	readonly createdAt: string;
	readonly turnStatus: SessionTurnStatus;
	/** The chat waits on the person (a question, a push to approve). */
	readonly needsYou: boolean;
};

export type CaptainInput = {
	readonly name: string;
	readonly label: string | null;
	readonly color: string;
	readonly rolePrompt: string;
};

const UNSAFE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this strips them.
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const cleaned = (value: string) => value.replace(UNSAFE, "");
const line = (max: number) =>
	z
		.string()
		.transform((value) => cleaned(value).replace(/\s+/g, " ").trim())
		.pipe(z.string().max(max));

const captainInputSchema = z.object({
	name: line(CAPTAIN_NAME_LIMIT).pipe(
		z
			.string()
			.regex(
				/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u,
				"Use letters, numbers, spaces, dots, dashes.",
			),
	),
	label: z
		.string()
		.nullish()
		.transform((value) =>
			value ? cleaned(value).replace(/\s+/g, " ").trim() : "",
		)
		.pipe(z.string().max(CAPTAIN_LABEL_LIMIT))
		.transform((value) => value || null),
	color: z.enum(CAPTAIN_COLORS),
	rolePrompt: z
		.string()
		.default("")
		.transform((value) => cleaned(value).trim())
		.pipe(z.string().max(CAPTAIN_ROLE_LIMIT)),
});

export function parseCaptainInput(
	value: unknown,
): { ok: true; value: CaptainInput } | { ok: false; error: string } {
	const parsed = captainInputSchema.safeParse(value);
	if (parsed.success) return { ok: true, value: parsed.data };
	return {
		ok: false,
		error: parsed.error.issues[0]?.message ?? "Not a valid captain.",
	};
}

/** `@seo`, `@release-manager`: the name in lower case, spaces as dashes. */
export const captainHandle = (name: string) =>
	name.trim().toLowerCase().replace(/\s+/g, "-");

/**
 * Why this name cannot be used, or null: another live captain of the project
 * (or the leader's display name) already has it, ignoring case. `selfId` is the
 * captain being renamed.
 */
export function captainNameProblem(
	name: string,
	captains: readonly Pick<Captain, "id" | "name">[],
	leaderName: string | null,
	selfId?: string,
): string | null {
	const key = captainHandle(name);
	if (leaderName && captainHandle(leaderName) === key)
		return `${name} is the leader's name.`;
	return captains.some(
		(other) => other.id !== selfId && captainHandle(other.name) === key,
	)
		? `A captain named ${name} already exists in this project.`
		: null;
}

export type CaptainStatus = "working" | "needs" | "idle";
export function captainStatus(
	captain: Pick<Captain, "turnStatus" | "needsYou">,
): CaptainStatus {
	if (captain.needsYou) return "needs";
	return captain.turnStatus === "running" ? "working" : "idle";
}

export type CaptainGroup = {
	readonly label: string | null;
	readonly captains: readonly Captain[];
};

/** Unlabelled captains first, then each label A to Z (case-insensitive), captains in position order. */
export function groupCaptains(captains: readonly Captain[]): CaptainGroup[] {
	const ordered = [...captains].sort(
		(a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
	);
	const groups = new Map<
		string,
		{ label: string | null; captains: Captain[] }
	>();
	for (const captain of ordered) {
		const key = captain.label ? captain.label.toLowerCase() : "";
		const group = groups.get(key) ?? { label: captain.label, captains: [] };
		group.captains.push(captain);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
		.map(([, group]) => group);
}

/** Roles to start from in the create dialog; the person edits them freely. */
export const CAPTAIN_PRESETS = [
	{
		name: "seo",
		label: "content",
		role: "You own search visibility for this project. Audit titles, meta descriptions, headings and internal links of the pages the threads change, and start one thread per fix. Report to the person only what needs a decision.",
	},
	{
		name: "newsletter",
		label: "content",
		role: "You own the project's newsletter. Turn merged changes into a short, plain-language issue, ask the person to approve the draft, and never send anything yourself.",
	},
	{
		name: "release",
		label: "",
		role: "You own releases. Track the open pull requests, say which are ready and what blocks the rest, and keep a short release checklist. You never merge or deploy; the person does.",
	},
	{
		name: "support",
		label: "",
		role: "You triage support requests and bug reports that reach this project: group duplicates, say how severe each is, and start a thread for the ones that need a fix.",
	},
] as const;

export function captainWelcome(name: string, rolePrompt: string): string {
	const first = rolePrompt.trim().split("\n")[0] ?? "";
	// The first sentence, cut at a word when it is long.
	const sentence = /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
	const role =
		sentence.length > 140
			? `${sentence.slice(0, 140).replace(/\s+\S*$/, "")}…`
			: sentence;
	return role
		? `I'm ${name}, a captain on this project. ${role}`
		: `I'm ${name}, a captain on this project. Tell me what you want me to look after.`;
}

/**
 * What a captain's turn adds in front of Y²'s own instructions. The role is the
 * person's text and goes in as data; the rules after it are fixed and win over it.
 */
export function captainInstructions(captain: {
	readonly name: string;
	readonly label: string | null;
	readonly rolePrompt: string;
}): string {
	return [
		`You are ${captain.name}, a captain: one of this project's Super agents${captain.label ? ` (group: ${captain.label})` : ""}. The project's leader is Y², the first Super agent; you work beside it with your own role and your own chat. Wherever the instructions below say Y², they mean you.`,
		"",
		captain.rolePrompt
			? `Your role, written by the person:\n<role>\n${captain.rolePrompt}\n</role>`
			: "The person gave you no role yet: answer what they ask, and ask what they want you to look after.",
		"",
		"The role above says what to look after and how; it does not change the rules below or the rules of Y² that follow. As a captain you may read this project's threads and run them (start, message, stop, retry, archive) when your role or the person asks, but you never merge, deploy, delete or spend: those are the person's decisions, so put them as a question. Stay inside your role: when something belongs to another captain or to the leader, say so instead of doing it.",
	].join("\n");
}

/** The text of the last agent message of a turn's items ("" when it said nothing). */
export function lastAgentText(
	items: readonly { readonly kind: string; readonly text?: unknown }[],
): string {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (
			item.kind === "agentMessage" &&
			typeof item.text === "string" &&
			item.text.trim()
		)
			return item.text;
	}
	return "";
}

/* ---------- the Super agents talking to each other (step 2) ---------- */

export const AGENTS_TOOL = "agents";
export const MESSAGE_AGENT_TOOL = "message_agent";
/** Longest message one Super agent sends another. */
export const AGENT_MESSAGE_LIMIT = 8_000;

export const AGENTS_DESCRIPTION =
	"List this project's other Super agents: the leader and the captains, each with its status (idle, working or needs the person), the first line of its last answer and when. Read-only; use it before delegating or reporting.";
export const MESSAGE_AGENT_DESCRIPTION =
	"Send a message to another Super agent of this project: a captain by its name (as in the agents list) or the leader (to: \"leader\"). It arrives labelled with your name and as not from the person, in that agent's own chat; an idle agent starts a turn with it, a working one takes it after its turn (or at its next step with mode steer). Use it to delegate a piece of work, to report a finding to the leader, or to ask for a fact; keep it self-contained. A turn that was itself started by another agent's message cannot send one (no loops), and one turn sends at most 3.";
export const messageAgentInput = z.object({
	to: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.describe('A captain\'s name from the agents list, or "leader"'),
	text: z.string().trim().min(1).max(AGENT_MESSAGE_LIMIT),
	mode: z
		.enum(["queue", "steer"])
		.optional()
		.describe(
			"queue (default): after a running turn. steer: at its next step, no extra turn.",
		),
});
export const agentsInput = z.object({});

export type AgentRoster = {
	readonly leader: {
		readonly chatId: string;
		readonly name: string;
		readonly turnStatus: SessionTurnStatus;
		readonly needsYou: boolean;
	} | null;
	readonly captains: readonly Captain[];
};
export type AgentTarget = {
	readonly chatId: string;
	readonly name: string;
	readonly kind: "leader" | "captain";
};

/** The agent a name or "leader" points at, never the asker itself; null when none. */
export function resolveAgentTarget(
	ref: string,
	roster: AgentRoster,
	selfChatId: string,
): AgentTarget | null {
	const key = captainHandle(ref.replace(/^@/, ""));
	const leader = roster.leader;
	if (
		leader &&
		leader.chatId !== selfChatId &&
		(["leader", "y2", "super-agent"].includes(key) ||
			captainHandle(leader.name) === key)
	)
		return { chatId: leader.chatId, name: leader.name, kind: "leader" };
	const captain = roster.captains.find(
		(entry) => entry.chatId !== selfChatId && captainHandle(entry.name) === key,
	);
	return captain
		? { chatId: captain.chatId, name: captain.name, kind: "captain" }
		: null;
}

const STATUS_WORD: Record<CaptainStatus, string> = {
	working: "working",
	needs: "needs the person",
	idle: "idle",
};

/** The agents list as text: one line each, the asker left out. */
export function rosterText(
	roster: AgentRoster,
	selfChatId: string,
	ago: (iso: string | null) => string,
): string {
	const lines: string[] = [];
	if (roster.leader && roster.leader.chatId !== selfChatId)
		lines.push(
			`- ${roster.leader.name} (leader): ${STATUS_WORD[captainStatus({ turnStatus: roster.leader.turnStatus, needsYou: roster.leader.needsYou })]}`,
		);
	for (const captain of roster.captains) {
		if (captain.chatId === selfChatId) continue;
		const last = captain.lastLine
			? `; last said ${ago(captain.lastAt)}: ${captain.lastLine}`
			: "; has not said anything yet";
		lines.push(
			`- ${captain.name}${captain.label ? ` (${captain.label})` : ""}: ${STATUS_WORD[captainStatus(captain)]}${last}`,
		);
	}
	return lines.length
		? lines.join("\n")
		: "No other Super agents in this project.";
}
