import type { AgentProviderId } from "./agent-provider";
import {
	isTurnRunning,
	type SessionItem,
	type SessionTurnStatus,
} from "./session-item";
import type { SidebarChatPrNeed } from "./sidebar-pr";

export type SidebarChat = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus?: SessionTurnStatus;
	readonly listedModelId?: string | null;
	readonly harnessId?: AgentProviderId | null;
	readonly updatedAt?: string | null;
	readonly workspaceId?: string | null;
	readonly workingBranch?: string | null;
	readonly prUrl?: string | null;
	readonly prNeed?: SidebarChatPrNeed | null;
	/** What the chat waits on from the user, if anything (chatWaitingOn). */
	readonly waitingOn?: ChatWaitingOn | null;
};

type SidebarChatAttention = "running" | "attention" | "idle";

export const CHAT_SEEN_STORAGE_KEY = "ytimesy-chat-seen";

export function compactRelativeAge(
	from: string | null | undefined,
	nowMs = Date.now(),
) {
	if (!from) return null;
	const then = Date.parse(from);
	if (!Number.isFinite(then)) return null;
	const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
	if (seconds < 45) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	const weeks = Math.floor(days / 7);
	if (weeks < 5) return `${weeks}w`;
	return `${Math.floor(days / 30)}mo`;
}

export function sidebarChatSeenKey(input: {
	readonly id: string;
	readonly turnStatus?: SessionTurnStatus;
	readonly updatedAt?: string | null;
}) {
	return `${input.id}:${input.turnStatus ?? "idle"}:${input.updatedAt ?? ""}`;
}

export function parseSeenChatKeys(raw: string | null): readonly string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((key): key is string => typeof key === "string");
	} catch {
		return [];
	}
}

export function seenChatStorageValue(keys: readonly string[]) {
	return JSON.stringify([...new Set(keys)]);
}

export function sidebarChatAttention(input: {
	readonly running: boolean;
	readonly turnStatus?: SessionTurnStatus;
	readonly selected: boolean;
	readonly seen: boolean;
}): SidebarChatAttention {
	if (input.running) return "running";
	if (input.selected || input.seen) return "idle";
	if (input.turnStatus === "completed" || input.turnStatus === "failed") {
		return "attention";
	}
	return "idle";
}

export function sidebarHasAttentionChat(input: {
	readonly chats: readonly SidebarChat[];
	readonly selectedChatId?: string;
	readonly seenKeys: readonly string[];
	readonly busyChatIds?: readonly string[];
	readonly openTurnStatus?: SessionTurnStatus;
}): boolean {
	const seen = new Set(input.seenKeys);
	return input.chats.some((chat) => {
		const running = sidebarChatIsRunning({
			chatId: chat.id,
			turnStatus: chat.turnStatus,
			busyChatIds: input.busyChatIds ?? [],
			openChatId: input.selectedChatId,
			openTurnStatus: input.openTurnStatus,
		});
		return (
			sidebarChatAttention({
				running,
				turnStatus: chat.turnStatus,
				selected: chat.id === input.selectedChatId,
				seen: seen.has(sidebarChatSeenKey(chat)),
			}) === "attention"
		);
	});
}

export function sidebarChatsEmptyCopy(input: {
	loading: boolean;
	projectSelected: boolean;
}): string | null {
	if (input.loading) return "Loading chats…";
	if (!input.projectSelected) return "Pick a repository to start a chat.";
	return "No chats yet.";
}

export function newChatIsActive(input: {
	projectSelected: boolean;
	hasUserMessage: boolean;
}): boolean {
	return input.projectSelected && !input.hasUserMessage;
}

export const SIDEBAR_PINNED_STORAGE_KEY = "ytimesy-sidebar-pinned";
export const SIDEBAR_PINNED_CHATS_KEY = "ytimesy-pinned-chats";
export const SIDEBAR_COLLAPSED_PROJECTS_KEY =
	"ytimesy-sidebar-collapsed-projects";

export function parseCollapsedProjectIds(
	raw: string | null,
): readonly string[] {
	return parseSeenChatKeys(raw);
}

export function collapsedProjectStorageValue(ids: readonly string[]) {
	return seenChatStorageValue(ids);
}

export function projectFolderIsExpanded(input: {
	readonly projectId: string;
	readonly selectedProjectId?: string;
	readonly collapsedIds: readonly string[];
}): boolean {
	if (input.projectId !== input.selectedProjectId) return false;
	return !input.collapsedIds.includes(input.projectId);
}

export function toggleCollapsedProjectIds(
	collapsedIds: readonly string[],
	projectId: string,
): string[] {
	return collapsedIds.includes(projectId)
		? collapsedIds.filter((id) => id !== projectId)
		: [...collapsedIds, projectId];
}

export function withProjectExpanded(
	collapsedIds: readonly string[],
	projectId: string,
): string[] {
	return collapsedIds.filter((id) => id !== projectId);
}

export function sidebarIsPinnedInStorage(value: string | null): boolean {
	return value === "1";
}

export function sidebarPinnedStorageValue(pinned: boolean): "1" | "0" {
	return pinned ? "1" : "0";
}

export function parsePinnedChatIds(raw: string | null): readonly string[] {
	return parseSeenChatKeys(raw);
}

export function pinnedChatStorageValue(ids: readonly string[]) {
	return seenChatStorageValue(ids);
}

export function togglePinnedChatIds(
	pinnedIds: readonly string[],
	chatId: string,
): string[] {
	return pinnedIds.includes(chatId)
		? pinnedIds.filter((id) => id !== chatId)
		: [...pinnedIds, chatId];
}

export function chatsWithPinnedFirst(
	chats: readonly SidebarChat[],
	pinnedIds: readonly string[],
): SidebarChat[] {
	const pinned = new Set(pinnedIds);
	return [
		...chats.filter((chat) => pinned.has(chat.id)),
		...chats.filter((chat) => !pinned.has(chat.id)),
	];
}

export function selectedChatIdAfterDelete(input: {
	readonly chats: readonly { readonly id: string }[];
	readonly selectedChatId: string | undefined;
	readonly deletedChatId: string;
}): string | undefined {
	if (input.selectedChatId !== input.deletedChatId) {
		return input.selectedChatId;
	}
	return input.chats.find((chat) => chat.id !== input.deletedChatId)?.id;
}

export function withBusyChat(
	ids: readonly string[],
	chatId: string | undefined,
): string[] {
	if (!chatId || ids.includes(chatId)) return [...ids];
	return [...ids, chatId];
}

export function withoutBusyChat(
	ids: readonly string[],
	chatId: string | undefined,
): string[] {
	if (!chatId) return [...ids];
	return ids.filter((id) => id !== chatId);
}

export function composerBusyForOpenChat(input: {
	readonly openChatId: string | undefined;
	readonly busyChatIds: readonly string[];
}): boolean {
	return Boolean(
		input.openChatId && input.busyChatIds.includes(input.openChatId),
	);
}

export function sidebarChatIsRunning(input: {
	readonly chatId: string;
	readonly turnStatus?: SessionTurnStatus;
	readonly busyChatIds: readonly string[];
	readonly openChatId?: string;
	readonly openTurnStatus?: SessionTurnStatus;
}): boolean {
	if (input.busyChatIds.includes(input.chatId)) return true;
	if (input.chatId === input.openChatId) {
		return input.openTurnStatus === "running";
	}
	return input.turnStatus === "running";
}

export function withChatTurnStatus(
	chats: readonly SidebarChat[],
	chatId: string | undefined,
	turnStatus: SessionTurnStatus,
): SidebarChat[] {
	if (!chatId) return [...chats];
	return chats.map((chat) =>
		chat.id === chatId ? { ...chat, turnStatus } : chat,
	);
}

export function listedChatTurnStatus(
	chats: readonly SidebarChat[],
	chatId: string,
): SessionTurnStatus {
	return chats.find((chat) => chat.id === chatId)?.turnStatus ?? "idle";
}

export function listedChatModelId(
	chats: readonly SidebarChat[],
	chatId: string,
): string {
	return chats.find((chat) => chat.id === chatId)?.listedModelId?.trim() ?? "";
}

export function listedChatHarnessId(
	chats: readonly SidebarChat[],
	chatId: string,
	fallback: AgentProviderId,
): AgentProviderId {
	return chats.find((chat) => chat.id === chatId)?.harnessId ?? fallback;
}

export function composerHarnessForChat(input: {
	readonly listedHarnessId?: AgentProviderId | null;
	readonly connectionProvider?: AgentProviderId | null;
	readonly fallback: AgentProviderId;
}): AgentProviderId {
	return input.listedHarnessId ?? input.connectionProvider ?? input.fallback;
}

/**
 * A running sibling keeps polling after the user switches chats. Skip the
 * open row (its own interval handles that) and any chat whose Send is still
 * in flight so the submit and the poll do not share a guest.
 */
export function backgroundTurnPollChatIds(input: {
	readonly chats: readonly SidebarChat[];
	readonly openChatId?: string;
	readonly busyChatIds: readonly string[];
}): string[] {
	return input.chats
		.filter((chat) => {
			if (chat.id === input.openChatId) return false;
			if (input.busyChatIds.includes(chat.id)) return false;
			return isTurnRunning(chat.turnStatus ?? "idle");
		})
		.map((chat) => chat.id);
}

export function sessionViewAppliesToOpenChat(input: {
	readonly openChatId?: string;
	readonly agentSessionId: string | null;
}): boolean {
	return Boolean(
		input.agentSessionId && input.agentSessionId === input.openChatId,
	);
}

/**
 * Whether an unsent message returns to the composer on screen. It returns
 * only to the chat that sent it: a chat opened since (or a newer new-chat
 * draft, which shares the empty composer) must not receive it.
 */
export function unsentSendReturnsHere(input: {
	readonly sentEpoch: number;
	readonly currentEpoch: number;
	readonly sentChatId?: string;
	readonly openChatId?: string;
}): boolean {
	if (input.sentEpoch === input.currentEpoch) return true;
	return Boolean(input.sentChatId && input.sentChatId === input.openChatId);
}

/** A different project is open: none of the previous project's chat stays on screen. */
export function sessionWithoutOpenChat<
	T extends {
		readonly workspaceId: string | null;
		readonly agentSessionId: string | null;
		readonly selectedBranch?: string | null;
		readonly items: readonly SessionItem[];
		readonly turnStatus: SessionTurnStatus;
	},
>(session: T): T {
	return {
		...session,
		workspaceId: null,
		agentSessionId: null,
		selectedBranch: undefined,
		items: [],
		turnStatus: "idle",
	};
}

/** How the left sidebar lists chats: newest first across projects, or under each project. */
export type SidebarSort = "recent" | "projects";
export const SIDEBAR_SORT_KEY = "ytimesy-sidebar-sort";

export function parseSidebarSort(raw: string | null): SidebarSort {
	return raw === "recent" ? "recent" : "projects";
}

const activityMs = (chat: Pick<SidebarChat, "updatedAt">) => {
	const ms = chat.updatedAt ? Date.parse(chat.updatedAt) : Number.NaN;
	return Number.isNaN(ms) ? 0 : ms;
};

/** One project's chats as the sidebar received them. */
export type ProjectChats<P extends { readonly id: string }> = {
	readonly project: P;
	readonly chats: readonly SidebarChat[];
};

/**
 * Every chat across projects, newest activity first (pinned chats on top),
 * each with the project it belongs to.
 */
export function recentSidebarChats<P extends { readonly id: string }>(
	groups: readonly ProjectChats<P>[],
	pinnedIds: readonly string[] = [],
): { readonly chat: SidebarChat; readonly project: P }[] {
	const rows = groups
		.flatMap(({ project, chats }) => chats.map((chat) => ({ chat, project })))
		.sort((a, b) => activityMs(b.chat) - activityMs(a.chat));
	const pinned = new Set(pinnedIds);
	return [
		...rows.filter((row) => pinned.has(row.chat.id)),
		...rows.filter((row) => !pinned.has(row.chat.id)),
	];
}

/** Projects ordered by their newest chat's activity; projects without chats keep their order, last. */
export function projectsByRecentActivity<P extends { readonly id: string }>(
	projects: readonly P[],
	groups: readonly ProjectChats<P>[],
): P[] {
	const latest = new Map(
		groups.map(({ project, chats }) => [
			project.id,
			Math.max(0, ...chats.map(activityMs)),
		]),
	);
	return projects
		.map((project, index) => ({ project, index }))
		.sort(
			(a, b) =>
				(latest.get(b.project.id) ?? 0) - (latest.get(a.project.id) ?? 0) ||
				a.index - b.index,
		)
		.map(({ project }) => project);
}

/** Why a chat that is not running waits on the user. */
export type ChatWaitingOn =
	| "question"
	| "secret"
	| "plan"
	| "paused"
	| "failed";

/**
 * A chat needs the user when its turn ended on a card only they can answer
 * (an ask_user question, a secret request, a proposed plan, a paused model
 * switch) and nothing was sent since, or when its last turn failed.
 */
export function chatWaitingOn(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): ChatWaitingOn | null {
	if (turnStatus === "running") return null;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item || item.kind === "userMessage") break;
		if (item.kind === "userQuestion") return "question";
		if (item.kind === "secretRequest") return "secret";
		if (item.kind === "planProposal") return "plan";
		if (item.kind === "modelSwitch" && item.state === "awaitingApproval")
			return "paused";
	}
	return turnStatus === "failed" ? "failed" : null;
}

export function chatWaitingOnLabel(waitingOn: ChatWaitingOn) {
	return {
		question: "Has a question for you",
		secret: "Needs a secret",
		plan: "Plan waits for your approval",
		paused: "Paused for your approval",
		failed: "Last run failed",
	}[waitingOn];
}

export type SidebarStatusGroup = "needs-you" | "working" | "done";

export function sidebarStatusGroup(input: {
	readonly running: boolean;
	readonly waitingOn?: ChatWaitingOn | null;
}): SidebarStatusGroup {
	if (input.running) return "working";
	return input.waitingOn ? "needs-you" : "done";
}

/** Done rows shown before "Show N more". */
export const SIDEBAR_DONE_VISIBLE = 8;

/**
 * Rows split by status in order (Needs you, Working, Done), each keeping
 * the order it came in; Done shows its first SIDEBAR_DONE_VISIBLE rows
 * unless expanded.
 */
export function sidebarStatusSections<T>(
	rows: readonly T[],
	groupOf: (row: T) => SidebarStatusGroup,
	doneExpanded = false,
) {
	const byGroup = (group: SidebarStatusGroup) =>
		rows.filter((row) => groupOf(row) === group);
	const done = byGroup("done");
	return {
		needsYou: byGroup("needs-you"),
		working: byGroup("working"),
		done: doneExpanded ? done : done.slice(0, SIDEBAR_DONE_VISIBLE),
		doneTotal: done.length,
		doneHidden: doneExpanded
			? 0
			: Math.max(0, done.length - SIDEBAR_DONE_VISIBLE),
	};
}

/** Muted project dot colours (no settings yet): picked from the project id. */
export const PROJECT_COLORS = [
	"#6b8fd6",
	"#5fae8b",
	"#c9a45a",
	"#9a83d4",
	"#cf7d93",
	"#4fa8ad",
	"#c98a5e",
	"#8a9aa8",
] as const;

export function projectColor(projectId: string): string {
	let hash = 0;
	for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return PROJECT_COLORS[hash % PROJECT_COLORS.length] as string;
}
