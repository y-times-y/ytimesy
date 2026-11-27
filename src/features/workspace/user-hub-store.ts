import { useEffect, useRef, useSyncExternalStore } from "react";
import type { SessionTurnStatus } from "#/domain/session-item";
import { type HubStateMessage, hubTopic } from "#/domain/user-hub";

/**
 * The page's view of the user's hub socket (openUserHub), for every query
 * that would otherwise poll: while the hub delivers signals they read once
 * when their topic changes (and once on a reconnect), and do not poll;
 * otherwise they poll exactly as before.
 */

/** How a query the hub can signal learns of changes. */
export type HubDelivery = "push" | "poll";

export type HubConnection = {
	/** The socket delivers (its first whole map arrived, it has not dropped). */
	readonly open: boolean;
	/** The hub's last whole map carried signals: an older hub sends none. */
	readonly signals: boolean;
	/** The deploy the hub reported on its last whole map. */
	readonly build?: string;
};

export function hubDelivery(connection: HubConnection): HubDelivery {
	return connection.open && connection.signals ? "push" : "poll";
}

/** A query's polling interval: none while the hub pushes its changes, else as before. */
export function pollUnlessPushed<T>(
	delivery: HubDelivery,
	interval: T,
): T | false {
	return delivery === "push" ? false : interval;
}

/** What the page last heard from the hub, to tell what a message changed. */
export type HubMemory = {
	readonly signals: Readonly<Record<string, number>>;
	readonly turns: Readonly<Record<string, SessionTurnStatus>>;
	readonly wholeMaps: number;
	/** The hub's last event version (HubStateMessage.seq); none from an older hub. */
	readonly seq?: number;
};
export const EMPTY_HUB_MEMORY: HubMemory = {
	signals: {},
	turns: {},
	wholeMaps: 0,
};

/**
 * What watchers hear: the topics a change message moved (a chat's turn as
 * hubTopic.chat), or one resync after a reconnect, when anything may have
 * changed unheard. The first whole map is neither: the page has just read.
 */
export type HubChange =
	| { readonly kind: "topics"; readonly topics: ReadonlySet<string> }
	| { readonly kind: "resync" };

export function hubChangeFromMessage(
	memory: HubMemory,
	message: HubStateMessage,
): { memory: HubMemory; change: HubChange | null } {
	const turns: Record<string, SessionTurnStatus> = message.full
		? {}
		: { ...memory.turns };
	for (const [id, { turnStatus }] of Object.entries(message.chats))
		turns[id] = turnStatus;
	if (message.full) {
		const wholeMaps = memory.wholeMaps + 1;
		return {
			memory: {
				signals: { ...(message.signals ?? {}) },
				turns,
				wholeMaps,
				seq: message.seq,
			},
			change: wholeMaps > 1 ? { kind: "resync" } : null,
		};
	}
	// A version skipped: a push was lost, so anything may have changed.
	const gap =
		message.seq !== undefined &&
		memory.seq !== undefined &&
		message.seq !== memory.seq + 1;
	const topics = new Set<string>();
	for (const [topic, at] of Object.entries(message.signals ?? {}))
		if (memory.signals[topic] !== at) topics.add(topic);
	for (const [id, { turnStatus }] of Object.entries(message.chats))
		if (memory.turns[id] !== turnStatus) topics.add(hubTopic.chat(id));
	return {
		memory: {
			...memory,
			signals: { ...memory.signals, ...(message.signals ?? {}) },
			turns,
			seq: message.seq ?? memory.seq,
		},
		change: gap
			? { kind: "resync" }
			: topics.size
				? { kind: "topics", topics }
				: null,
	};
}

/** Topics a watcher reads on: a list, or a test (e.g. every chat's turn). */
export type HubTopics = readonly string[] | ((topic: string) => boolean);

export function hubChangeConcerns(change: HubChange, topics: HubTopics) {
	if (change.kind === "resync") return true;
	if (typeof topics === "function") return [...change.topics].some(topics);
	return topics.some((topic) => change.topics.has(topic));
}

/** Every chat's turn: a turn's end is when usage and the like move. */
export const anyChatTurn = (topic: string) => topic.startsWith("chat:");

/**
 * The agents list reads again when a helper of the chat (or of one of its
 * helpers) is opened, started, blocked or settled, or a helper's own turn
 * changes.
 */
export function agentPanelHubTopics(
	rootSessionId: string | undefined,
	helpers: readonly { readonly id: string }[],
): string[] {
	if (!rootSessionId) return [];
	return [
		hubTopic.agents(rootSessionId),
		...helpers.flatMap((helper) => [
			hubTopic.agents(helper.id),
			hubTopic.chat(helper.id),
		]),
	];
}

/**
 * Background commands read again when one of these chats starts or ends a
 * command, or its turn changes (a turn's end records the exits it saw).
 */
export function backgroundCommandHubTopics(
	sessionIds: readonly string[],
): string[] {
	return sessionIds.flatMap((id) => [hubTopic.commands(id), hubTopic.chat(id)]);
}

export function createUserHubStore() {
	let connection: HubConnection = { open: false, signals: false };
	let memory = EMPTY_HUB_MEMORY;
	const listeners = new Set<() => void>();
	const watchers = new Set<(change: HubChange) => void>();
	const update = (next: HubConnection) => {
		if (
			next.open === connection.open &&
			next.signals === connection.signals &&
			next.build === connection.build
		)
			return;
		connection = next;
		for (const listener of listeners) listener();
	};
	return {
		connection: () => connection,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setOpen(open: boolean) {
			update({ ...connection, open });
		},
		receive(message: HubStateMessage) {
			const result = hubChangeFromMessage(memory, message);
			memory = result.memory;
			if (message.full)
				update({
					...connection,
					signals: message.signals !== undefined,
					build: message.build ?? connection.build,
				});
			if (result.change) for (const watcher of watchers) watcher(result.change);
		},
		watch(watcher: (change: HubChange) => void) {
			watchers.add(watcher);
			return () => {
				watchers.delete(watcher);
			};
		},
	};
}

/** The page's one hub (workspace-home.tsx feeds it). */
export const userHubStore = createUserHubStore();

const CLOSED: HubConnection = { open: false, signals: false };

export function useHubConnection(): HubConnection {
	return useSyncExternalStore(
		userHubStore.subscribe,
		userHubStore.connection,
		() => CLOSED,
	);
}

/**
 * Whether a tab coming back into focus re-reads a query. Only a query the hub
 * covers (it has a push-or-poll interval: pollUnlessPushed) skips a quick
 * return while the hub pushes. A query nothing pushes (no interval, no hub
 * topic) always reads when stale: before, every query skipped it, so a
 * settings list or a project row changed elsewhere stayed old until a reload.
 */
export function focusRefetchWanted(
	connection: HubConnection,
	coveredByHub: boolean,
	tabAway: boolean,
	_now: number,
) {
	return !coveredByHub || hubDelivery(connection) !== "push" || tabAway;
}

export function refetchOnFocusUnlessPushed(query: {
	// refetchInterval is an observer option: a query is covered when one of
	// the components watching it sets a push-or-poll interval.
	observers: readonly { options: { refetchInterval?: unknown } }[];
}) {
	return focusRefetchWanted(
		userHubStore.connection(),
		query.observers.some(
			(observer) => observer.options.refetchInterval !== undefined,
		),
		tabWasAway(tabHiddenSince, Date.now()),
		Date.now(),
	);
}

/**
 * A tab hidden this long may have missed pushes even though its socket looks
 * open (a slept phone or laptop keeps a half-dead socket for minutes), so
 * coming back re-reads like any other tab.
 */
export const AWAY_REREAD_MS = 15_000;

export function tabWasAway(hiddenSince: number | null, now: number) {
	return hiddenSince !== null && now - hiddenSince >= AWAY_REREAD_MS;
}

/** When the tab was hidden; kept until the focus handlers of that return have run. */
let tabHiddenSince: number | null = null;
if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") tabHiddenSince = Date.now();
		// After this event's other listeners (the query client's focus
		// refetch) have asked.
		else setTimeout(() => (tabHiddenSince = null), 0);
	});
}

export function useHubDelivery(): HubDelivery {
	return hubDelivery(useHubConnection());
}

/**
 * When a read may run again after one ran at `lastAt`: now, or once
 * `minIntervalMs` has passed (a burst of changes reads once more after it).
 */
export function hubReadDelayMs(
	lastAt: number,
	now: number,
	minIntervalMs: number,
) {
	return Math.max(0, lastAt + minIntervalMs - now);
}

/**
 * Calls `read` once when one of `topics` changes, and once on a reconnect's
 * resync, while `enabled`. `minIntervalMs` spaces reads out: changes
 * within it are read together once it has passed.
 */
export function useHubRead(
	topics: HubTopics,
	read: () => void,
	options: { enabled?: boolean; minIntervalMs?: number } = {},
) {
	const latest = useRef({ topics, read, options });
	latest.current = { topics, read, options };
	useEffect(() => {
		let lastAt = Number.NEGATIVE_INFINITY;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const run = () => {
			timer = undefined;
			lastAt = Date.now();
			latest.current.read();
		};
		const stop = userHubStore.watch((change) => {
			const { topics, options } = latest.current;
			if (options.enabled === false || !hubChangeConcerns(change, topics))
				return;
			if (timer !== undefined) return;
			const delay = hubReadDelayMs(
				lastAt,
				Date.now(),
				options.minIntervalMs ?? 0,
			);
			if (delay === 0) run();
			else timer = setTimeout(run, delay);
		});
		return () => {
			stop();
			clearTimeout(timer);
		};
	}, []);
}
