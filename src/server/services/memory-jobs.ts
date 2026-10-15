import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { ApiTokenUsage } from "#/domain/api-token-usage";
import {
	appendMemoryEntry,
	chatIdFromSource,
	chatSourceUrl,
	type DreamChat,
	dreamInstructions,
	MEMORY_ENTRY,
	type MemoryChange,
	type MemoryFiles,
	type MemoryMode,
	memoryLines,
	memoryPath,
	parseSaveHookAnswer,
	renderDreamInbox,
	SAVE_HOOK_INSTRUCTIONS,
	saveHookPrompt,
	withoutExpired,
} from "#/domain/memory-repo";
import type { ModelRoute } from "#/domain/model-failover";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { reserveMemoryTokens } from "../adapters/api-usage-budget";
import {
	type MemoryRepo,
	type MemorySnapshot,
	memoryRepo,
	memoryRepoName,
} from "../adapters/memory-repos";
import {
	latestUserModelRoute,
	type MemoryChat,
	type MemorySettings,
	markMemoryDreamed,
	memoryChat,
	memoryChatsSince,
	memorySettings,
	recordMemoryModelUsage,
} from "../adapters/memory-settings";
import { runApiAgent } from "./api-agent-runtime";
import { runCodexSubscriptionAgent } from "./codex-subscription-agent";
import type { ModelAgentInput } from "./model-agent-loop";

/** Seconds a user's chats must be idle before their memory is dreamed. */
export const DREAM_IDLE_SECONDS = 15 * 60;
export const DREAM_MAX_STEPS = 24;
const DREAM_TIMEOUT_MS = 12 * 60 * 1000;
const SAVE_TIMEOUT_MS = 90_000;
const SOURCE_CHARS = 12_000;
const READ_LINES = 200;

/** Everything a memory job touches outside itself; tests replace these. */
export type MemoryJobDeps = {
	settings(userId: string): Promise<MemorySettings>;
	repo(userId: string, settings: MemorySettings): MemoryRepo | null;
	chatsSince(userId: string, since: Date | null): Promise<MemoryChat[]>;
	chat(userId: string, sessionId: string): Promise<MemoryChat | null>;
	route(userId: string): Promise<ModelRoute | null>;
	runAgent(
		input: ModelAgentInput,
		route: { subscription: boolean; connectionId: string | null },
	): Promise<ModelMessage[]>;
	reserve(userId: string, tokens: number): Promise<void>;
	recordUsage(row: Parameters<typeof recordMemoryModelUsage>[0]): Promise<void>;
	markDreamed(userId: string, through: Date): Promise<void>;
	appUrl: string;
	today(): string;
};

export function memoryJobDeps(): MemoryJobDeps {
	return {
		settings: memorySettings,
		repo: (userId, settings) =>
			memoryRepo(memoryRepoName(userId, settings.repo)),
		chatsSince: (userId, since) => memoryChatsSince(userId, since),
		chat: memoryChat,
		route: latestUserModelRoute,
		runAgent: (input, route) =>
			route.subscription
				? runCodexSubscriptionAgent(input)
				: runApiAgent({ ...input, connectionId: route.connectionId as string }),
		reserve: async (userId, tokens) => {
			await reserveMemoryTokens(userId, tokens);
		},
		recordUsage: recordMemoryModelUsage,
		markDreamed: markMemoryDreamed,
		appUrl: process.env.APP_URL ?? "http://localhost:3000",
		today: () => new Date().toISOString().slice(0, 10),
	};
}

/**
 * One run on the user's own model route, billed like a chat turn: API
 * connections reserve against the user's daily token budget before each
 * step, a ChatGPT plan spends the user's plan allowance, and the usage is
 * recorded per job.
 */
async function runOnUserModel(
	deps: MemoryJobDeps,
	input: {
		userId: string;
		kind: "save" | "dream";
		sessionId: string | null;
		route: ModelRoute;
		instructions: string;
		prompt: string;
		tools: ToolSet;
		maxSteps: number;
		endTurnTools?: string[];
		timeoutMs: number;
	},
) {
	const subscription = subscriptionTurnSettings(input.route.connectionRevision);
	if (!subscription && !input.route.connectionId)
		return { outcome: "no-route", text: "", steps: 0 } as const;
	let usage: ApiTokenUsage | null = null;
	let steps = 0;
	let text = "";
	let outcome = "completed";
	try {
		await deps.runAgent(
			{
				userId: input.userId,
				modelId: input.route.modelId,
				connectionId: input.route.connectionId ?? undefined,
				connectionRevision: input.route.connectionRevision,
				reasoning: subscription?.reasoning ?? input.route.settings?.reasoning,
				cacheScopeId: `memory:${input.userId}`,
				messages: [{ role: "user", content: input.prompt }],
				instructions: input.instructions,
				tools: input.tools,
				maxSteps: input.maxSteps,
				endTurnTools: input.endTurnTools,
				maxOutputTokens: 4096,
				signal: AbortSignal.timeout(input.timeoutMs),
				beforeStep: async (history) => {
					steps++;
					if (!subscription)
						await deps.reserve(
							input.userId,
							Buffer.byteLength(JSON.stringify(history), "utf8") + 8_000,
						);
				},
				onStep: async () => {},
				onEvent: async (event) => {
					if (event.type === "usage") usage = event.usage;
					if (event.type === "text-delta") text += event.text;
				},
			},
			{
				subscription: Boolean(subscription),
				connectionId: input.route.connectionId,
			},
		);
	} catch (error) {
		outcome =
			error instanceof Error && error.name === "IncompleteAgentTurn"
				? "step-limit"
				: `failed:${error instanceof Error ? error.name : "unknown"}`;
	}
	await deps
		.recordUsage({
			userId: input.userId,
			kind: input.kind,
			sessionId: input.sessionId,
			modelId: input.route.modelId,
			usage,
			steps,
			outcome,
		})
		.catch(() => console.warn("Memory model usage could not be recorded."));
	return { outcome, text, steps } as const;
}

// ---- save hook -------------------------------------------------------------

/**
 * After every completed turn (as Supermemory's hook does): a single cheap
 * pass over the user's latest message saves a durable preference, decision
 * or correction the agent did not save itself.
 */
export async function runMemorySave(
	userId: string,
	sessionId: string,
	deps: MemoryJobDeps = memoryJobDeps(),
) {
	const settings = await deps.settings(userId);
	if (settings.mode !== "full") return "off";
	const repo = deps.repo(userId, settings);
	const chat = await deps.chat(userId, sessionId);
	if (!repo || !chat) return "unavailable";
	const message = [...chat.items]
		.reverse()
		.find((item) => item.kind === "userMessage");
	if (message?.kind !== "userMessage") return "skipped";
	const route = await deps.route(userId);
	if (!route) return "no-route";
	let snapshot = await repo.snapshot();
	const related = relatedLines(snapshot.files, message.text);
	const project = chat.project;
	const run = await runOnUserModel(deps, {
		userId,
		kind: "save",
		sessionId,
		route,
		instructions: SAVE_HOOK_INSTRUCTIONS,
		prompt: saveHookPrompt({
			message: message.text.slice(0, 6000),
			memory: related.join("\n"),
			files: Object.keys(snapshot.files).filter((path) => path.endsWith(".md")),
			project,
		}),
		tools: {},
		maxSteps: 1,
		timeoutMs: SAVE_TIMEOUT_MS,
	});
	if (run.outcome !== "completed") return run.outcome;
	const entries = parseSaveHookAnswer(run.text);
	if (!entries.length) return "nothing-new";
	const source = chatSourceUrl(deps.appUrl, sessionId);
	for (let attempt = 0; attempt < 2; attempt++) {
		const changes = saveHookChanges(snapshot.files, entries, {
			source,
			today: deps.today(),
		});
		if (!changes.length) return "nothing-new";
		const outcome = await repo.commit(
			snapshot,
			changes,
			`Remember from chat ${sessionId.slice(0, 8)} (save hook)`,
		);
		if (outcome.ok) return "saved";
		snapshot = await repo.snapshot();
	}
	return "conflict";
}

export function saveHookChanges(
	files: MemoryFiles,
	entries: ReturnType<typeof parseSaveHookAnswer>,
	context: { source: string; today: string },
) {
	const working = { ...files };
	const changed = new Set<string>();
	const known = memoryLines(files).map((entry) => entry.text.toLowerCase());
	for (const entry of entries) {
		if (known.some((text) => text.includes(entry.text.toLowerCase()))) continue;
		const meta = [
			...(entry.project ? [`project: ${entry.project}`] : []),
			`source: ${context.source}`,
			`added: ${context.today}`,
		].join("; ");
		for (const change of appendMemoryEntry(
			working,
			entry.file,
			`- ${entry.text} [${meta}]`,
		)) {
			if (change.content === null) delete working[change.path];
			else working[change.path] = change.content;
			changed.add(change.path);
		}
		known.push(entry.text.toLowerCase());
	}
	return [...changed].map((path) => ({
		path,
		content: working[path] ?? null,
	}));
}

/** Lines sharing a distinctive word with the message: enough context to avoid duplicates. */
function relatedLines(files: MemoryFiles, message: string) {
	const words = new Set(
		message
			.toLowerCase()
			.split(/[^a-z0-9@._/-]+/)
			.filter((word) => word.length >= 4),
	);
	return memoryLines(files)
		.filter((entry) =>
			entry.text
				.toLowerCase()
				.split(/[^a-z0-9@._/-]+/)
				.some((word) => words.has(word)),
		)
		.slice(0, 40)
		.map((entry) => `${entry.path}:${entry.line}: ${entry.raw.trim()}`);
}

// ---- dreaming -----------------------------------------------------------------

/** What a dream reads from one chat: only turns after the last dream. */
export function dreamChat(
	chat: MemoryChat,
	since: Date | null,
	appUrl: string,
	withFailures: boolean,
): DreamChat {
	const sinceMs = since?.getTime() ?? 0;
	const userMessages: string[] = [];
	const agentReplies: string[] = [];
	const failedCommands: { command: string; output: string }[] = [];
	let included = false;
	let reply: string | null = null;
	const flush = () => {
		if (included && reply) agentReplies.push(reply);
		reply = null;
	};
	for (const item of chat.items as SessionItem[]) {
		if (item.kind === "userMessage") {
			flush();
			included = !item.timing?.startedAt || item.timing.startedAt > sinceMs;
			if (included) userMessages.push(item.text);
		} else if (!included) {
		} else if (item.kind === "agentMessage" && item.phase !== "commentary")
			reply = item.text;
		else if (
			withFailures &&
			item.kind === "commandExecution" &&
			item.exitCode !== null &&
			item.exitCode !== 0 &&
			failedCommands.length < 5
		)
			failedCommands.push({
				command: item.command,
				output: (item.output ?? "").slice(-600),
			});
	}
	flush();
	return {
		url: chatSourceUrl(appUrl, chat.id),
		title: chat.title,
		updatedAt: chat.updatedAt.toISOString(),
		userMessages,
		agentReplies,
		failedCommands,
	};
}

function transcript(chat: MemoryChat) {
	const lines = chat.items.flatMap((item) =>
		item.kind === "userMessage"
			? [`User: ${item.text}`]
			: item.kind === "agentMessage" && item.phase !== "commentary"
				? [`Agent: ${item.text}`]
				: [],
	);
	const text = `# ${chat.title}\n${lines.join("\n")}`;
	return text.length > SOURCE_CHARS ? `${text.slice(0, SOURCE_CHARS)}…` : text;
}

/** The dreamer's tools over a writable copy of the repo; nothing is pushed until commit. */
export function dreamTools(input: {
	files: MemoryFiles;
	readSource: (link: string) => Promise<string>;
	onCommit: (message: string) => void;
}): ToolSet {
	const { files } = input;
	return {
		search: tool({
			description:
				"Search every memory line with a case-insensitive regular expression. Returns path:line: text for up to 60 lines.",
			inputSchema: z.object({ pattern: z.string().min(1).max(200) }),
			execute: async ({ pattern }) => {
				let regex: RegExp;
				try {
					regex = new RegExp(pattern, "i");
				} catch {
					regex = new RegExp(
						pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
						"i",
					);
				}
				const hits = Object.entries(files).flatMap(([path, content]) =>
					content
						.split("\n")
						.flatMap((line, index) =>
							regex.test(line) ? [`${path}:${index + 1}: ${line}`] : [],
						),
				);
				return hits.slice(0, 60).join("\n") || "no matches";
			},
		}),
		read_file: tool({
			description: `Read lines of a memory file (1-based, at most ${READ_LINES} lines per call).`,
			inputSchema: z.object({
				path: z.string(),
				from: z.number().int().min(1).optional(),
				to: z.number().int().min(1).optional(),
			}),
			execute: async ({ path, from = 1, to }) => {
				const relative = memoryPath(path);
				const content = relative ? files[relative] : undefined;
				if (content === undefined) return `no such file: ${path}`;
				const lines = content.split("\n");
				const end = Math.min(
					to ?? from + READ_LINES - 1,
					from + READ_LINES - 1,
				);
				return `${relative} (${lines.length} lines)\n${lines
					.slice(from - 1, end)
					.map((line, index) => `${from + index}: ${line}`)
					.join("\n")}`;
			},
		}),
		write_file: tool({
			description: "Create or replace a whole memory file.",
			inputSchema: z.object({
				path: z.string(),
				content: z.string().max(100_000),
			}),
			execute: async ({ path, content }) => {
				const relative = memoryPath(path);
				if (!relative) return `refused: ${path} is not a memory path`;
				files[relative] = content.endsWith("\n") ? content : `${content}\n`;
				return `wrote ${relative}`;
			},
		}),
		delete_file: tool({
			description: "Delete a memory file after merging its content elsewhere.",
			inputSchema: z.object({ path: z.string() }),
			execute: async ({ path }) => {
				const relative = memoryPath(path);
				if (!relative || relative === MEMORY_ENTRY || !(relative in files))
					return `refused: ${path}`;
				delete files[relative];
				return `deleted ${relative}`;
			},
		}),
		read_source: tool({
			description:
				"Read the chat behind a [source: …] link: its user messages and the agent's replies.",
			inputSchema: z.object({ link: z.string() }),
			execute: async ({ link }) => input.readSource(link),
		}),
		commit: tool({
			description:
				"Finish: commit all edits as one commit. Call exactly once, last.",
			inputSchema: z.object({ message: z.string().min(1).max(300) }),
			execute: async ({ message }) => {
				input.onCommit(message);
				return "committed";
			},
		}),
	};
}

export function dreamChanges(
	before: MemoryFiles,
	after: MemoryFiles,
): MemoryChange[] {
	return [
		...Object.entries(after)
			.filter(([path, content]) => before[path] !== content)
			.map(([path, content]) => ({ path, content })),
		...Object.keys(before)
			.filter((path) => !(path in after))
			.map((path) => ({ path, content: null })),
	];
}

export type DreamOutcome =
	| "off"
	| "unavailable"
	| "idle"
	| "no-route"
	| "committed"
	| "unchanged"
	| "incomplete"
	| "conflict"
	| string;

/**
 * One dream: read only what changed since the last dream (new chats, and
 * the memory lines they touch), then make one commit. Bounded by a step cap
 * and a deadline inside one alarm.
 */
export async function runMemoryDream(
	userId: string,
	deps: MemoryJobDeps = memoryJobDeps(),
	maxSteps = DREAM_MAX_STEPS,
): Promise<DreamOutcome> {
	const settings = await deps.settings(userId);
	if (settings.mode === "off") return "off";
	const repo = deps.repo(userId, settings);
	if (!repo) return "unavailable";
	const chats = await deps.chatsSince(userId, settings.dreamedThrough);
	if (!chats.length) return "idle";
	const through = new Date(
		Math.max(...chats.map((chat) => chat.updatedAt.getTime())),
	);
	const mode: MemoryMode = settings.mode;
	const inboxChats = chats
		.map((chat) =>
			dreamChat(chat, settings.dreamedThrough, deps.appUrl, mode === "full"),
		)
		.filter((chat) => chat.userMessages.length);
	if (!inboxChats.length) {
		await deps.markDreamed(userId, through);
		return "idle";
	}
	const route = await deps.route(userId);
	if (!route) return "no-route";
	const snapshot: MemorySnapshot = await repo.snapshot();
	const working: MemoryFiles = { ...snapshot.files };
	if (mode === "full")
		for (const change of withoutExpired(working, deps.today()))
			if (change.content !== null) working[change.path] = change.content;
	let message: string | null = null;
	const tools = dreamTools({
		files: working,
		onCommit: (text) => {
			message = text;
		},
		readSource: async (link) => {
			const id = chatIdFromSource(link);
			const chat = id ? await deps.chat(userId, id) : null;
			return chat ? transcript(chat) : `no chat found for ${link}`;
		},
	});
	const listing = Object.entries(working)
		.map(([path, content]) => `${path} (${content.split("\n").length} lines)`)
		.join("\n");
	const run = await runOnUserModel(deps, {
		userId,
		kind: "dream",
		sessionId: null,
		route,
		instructions: dreamInstructions(mode, deps.today()),
		prompt: `New chats since the last dream:\n\n${renderDreamInbox(inboxChats)}\n\nMemory files:\n${listing || "(empty repo)"}\n\nMEMORY.md:\n${working[MEMORY_ENTRY] ?? "(missing)"}`,
		tools,
		maxSteps,
		endTurnTools: ["commit"],
		timeoutMs: DREAM_TIMEOUT_MS,
	});
	if (run.outcome === "no-route") return "no-route";
	if (message === null) {
		// The inbox is spent either way, so a stuck dream never bills twice.
		await deps.markDreamed(userId, through);
		return "incomplete";
	}
	const changes = dreamChanges(snapshot.files, working);
	if (changes.length) {
		const outcome = await repo.commit(
			snapshot,
			changes,
			`Dream: ${String(message).slice(0, 200)}`,
		);
		if (!outcome.ok) return "conflict";
	}
	await deps.markDreamed(userId, through);
	return changes.length ? "committed" : "unchanged";
}
