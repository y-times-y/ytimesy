import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { ApiTokenUsage } from "#/domain/api-token-usage";
import { clip } from "#/domain/clip";
import { DREAM_COMMIT_PREFIX } from "#/domain/memory-dream-schedule";
import {
	layoutMarker,
	lineInScope,
	MEMORY_LAYOUT_MARKER,
	type MemoryProject,
	memoryFolderOf,
	memoryPathScope,
	PERSONAL_FOLDER,
	personalSortPending,
	projectFolderListing,
	projectFolderPath,
	projectKeyFor,
	projectNameMatches,
	staleMemoryLines,
} from "#/domain/memory-layout";
import { type SavedMemoryLine, savedMemoryLines } from "#/domain/memory-marker";
import { lexicalScores, memoryMatchScores } from "#/domain/memory-ranking";
import {
	appendMemoryEntry,
	byFileAndLine,
	chatIdFromSource,
	chatSourceUrl,
	cosineSimilarity,
	type DreamChat,
	dreamInstructions,
	dreamReviewSection,
	droppedDetails,
	hasDurableCue,
	isNearDuplicate,
	isRetired,
	MEMORY_ENTRY,
	type MemoryChange,
	type MemoryFiles,
	type MemoryLine,
	type MemoryMode,
	memoryAppUrl,
	memoryBullet,
	memoryLineEmbeddingText,
	memoryLines,
	memoryPath,
	memoryToday,
	parseMemoryLine,
	parseSaveHookAnswer,
	renderDreamInbox,
	SAVE_HOOK_INSTRUCTIONS,
	SAVE_HOOK_MEMORY_CHARS,
	saveHookLine,
	saveHookPrompt,
	supersededLine,
	withMemoryChanges,
	withoutExpired,
} from "#/domain/memory-repo";
import type { ModelRoute } from "#/domain/model-failover";
import type { SessionItem } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { reserveMemoryTokens } from "../adapters/api-usage-budget";
import {
	cachedLineEmbeddings,
	memoryEmbedder,
} from "../adapters/memory-embeddings";
import {
	type MemoryRepo,
	type MemorySnapshot,
	memoryRepo,
	memoryRepoName,
} from "../adapters/memory-repos";
import {
	lastMemoryReview,
	latestUserModelRoute,
	type MemoryChat,
	type MemorySettings,
	markMemoryDreamed,
	memoryChat,
	memoryChatsSince,
	memoryProjects,
	memoryRecalls,
	memorySettings,
	recordMemoryModelUsage,
	recordMemorySaved,
} from "../adapters/memory-settings";
import { runApiAgent } from "./api-agent-runtime";
import { runCodexSubscriptionAgent } from "./codex-subscription-agent";
import { memoryInLayout } from "./memory-layout";
import type { ModelAgentInput } from "./model-agent-loop";

/** Seconds a user's chats must be idle before their memory is dreamed. */
export const DREAM_IDLE_SECONDS = 15 * 60;
const DREAM_MAX_STEPS = 24;
/** A dream that also reviews the whole repo gets more steps for its rewrites. */
const REVIEW_MAX_STEPS = 36;
/** How often a dream also reviews the whole repo. */
export const DREAM_REVIEW_DAYS = 7;
/** Recorded as a save's outcome suffix when it found nothing to save; recentUnsavedMessages looks for it. */
export const SAVE_NOTHING_OUTCOME = ":nothing-new";
/** Recorded as the dream's outcome suffix; lastMemoryReview looks for it. */
export const DREAM_REVIEW_OUTCOME = ":review";
const DREAM_TIMEOUT_MS = 12 * 60 * 1000;
const SAVE_TIMEOUT_MS = 90_000;
/** The save hook's one retry after a failed model call (a 5xx, a dropped connection). */
const SAVE_RETRY_DELAY_MS = 2000;
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
	/** Shows the save hook's lines under the turn they came from. */
	recordSaved(
		userId: string,
		sessionId: string,
		userMessageId: string,
		lines: readonly SavedMemoryLine[],
	): Promise<boolean>;
	/** When the user's last whole-repo dream review ran, or null. */
	lastReview(userId: string): Promise<Date | null>;
	/** Embeds new memory lines ahead of the next chat's read hook. */
	warmLines(userId: string, texts: readonly string[]): Promise<void>;
	/** Cosine similarity of each line to the message, or null without embeddings. */
	similarity(
		userId: string,
		lines: readonly MemoryLine[],
		message: string,
	): Promise<Map<MemoryLine, number> | null>;
	/**
	 * For each new entry (as a line in `file`), the existing line it embeds
	 * closest to and their cosine; null without embeddings.
	 */
	closestLines(
		userId: string,
		lines: readonly MemoryLine[],
		entries: readonly { file: string; text: string }[],
	): Promise<({ line: MemoryLine; similarity: number } | null)[] | null>;
	/** The user's projects: legacy `project:` names map to their folders. */
	projects(userId: string): Promise<MemoryProject[]>;
	/** When lines were last recalled, and since when recalls are tracked. */
	recalls(
		userId: string,
		texts: readonly string[],
	): Promise<{ recalled: Map<string, string>; since: string | null }>;
	appUrl: string;
	today(): string;
	/** Waits before a retry; tests skip the wait. */
	sleep?(ms: number): Promise<void>;
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
		recordSaved: recordMemorySaved,
		lastReview: lastMemoryReview,
		warmLines: async (userId, texts) => {
			const embed = memoryEmbedder();
			if (embed && texts.length)
				await cachedLineEmbeddings(userId, texts, embed);
		},
		similarity: async (userId, lines, message) => {
			const embed = memoryEmbedder();
			if (!embed || !lines.length) return null;
			const [query, vectors] = await Promise.all([
				embed.query(message.slice(0, 2000)),
				cachedLineEmbeddings(
					userId,
					lines.map((entry) => memoryLineEmbeddingText(entry)),
					embed,
				),
			]);
			return new Map(
				lines.map((entry, index) => [
					entry,
					cosineSimilarity(query, vectors[index] ?? []),
				]),
			);
		},
		closestLines: async (userId, lines, entries) => {
			const embed = memoryEmbedder();
			if (!embed || !entries.length) return null;
			if (!lines.length) return entries.map(() => null);
			const [vectors, fresh] = await Promise.all([
				cachedLineEmbeddings(
					userId,
					lines.map((entry) => memoryLineEmbeddingText(entry)),
					embed,
				),
				embed.documents(
					entries.map((entry) =>
						memoryLineEmbeddingText({ path: entry.file, text: entry.text }),
					),
				),
			]);
			return fresh.map((vector) => {
				let best: { line: MemoryLine; similarity: number } | null = null;
				lines.forEach((line, index) => {
					const similarity = cosineSimilarity(vector, vectors[index] ?? []);
					if (!best || similarity > best.similarity)
						best = { line, similarity };
				});
				return best;
			});
		},
		projects: memoryProjects,
		recalls: memoryRecalls,
		appUrl: memoryAppUrl(),
		today: memoryToday,
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
		/** Appended to the recorded outcome; a function sees the model's answer. */
		outcomeSuffix?: string | ((text: string) => string);
		/**
		 * A completed run's usage is recorded when the caller calls `record`
		 * (a failed one at once), so the row also says the job is done.
		 */
		deferRecord?: boolean;
		/** The provider prompt-cache scope; each kind of job caches its own prefix. */
		cacheScope?: string;
	},
) {
	const subscription = subscriptionTurnSettings(input.route.connectionRevision);
	if (!subscription && !input.route.connectionId)
		return { outcome: "no-route", text: "", steps: 0, record: null } as const;
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
				cacheScopeId: input.cacheScope ?? `memory:${input.userId}`,
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
	const record = (suffix: string) =>
		deps
			.recordUsage({
				userId: input.userId,
				kind: input.kind,
				sessionId: input.sessionId,
				modelId: input.route.modelId,
				usage,
				steps,
				outcome: `${outcome}${suffix}`,
			})
			.catch(() => console.warn("Memory model usage could not be recorded."));
	const deferred = input.deferRecord && outcome === "completed";
	if (!deferred)
		await record(
			typeof input.outcomeSuffix === "function"
				? outcome === "completed"
					? input.outcomeSuffix(text)
					: ""
				: (input.outcomeSuffix ?? ""),
		);
	return { outcome, text, steps, record: deferred ? record : null } as const;
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
	// The first access after the per-project layout shipped moves the repo into it.
	let snapshot = await memoryInLayout(repo, () => deps.projects(userId));
	if (!hasDurableCue(message.text)) {
		// Nothing in the message reads as worth keeping: no model call. Recorded
		// as found-nothing, so other chats stop waiting for it and showing it.
		await deps
			.recordUsage({
				userId,
				kind: "save",
				sessionId,
				modelId: route.modelId,
				usage: null,
				steps: 0,
				outcome: `skipped${SAVE_NOTHING_OUTCOME}`,
			})
			.catch(() => console.warn("Memory model usage could not be recorded."));
		return "no-cue";
	}
	const project = chat.projectRef ?? null;
	const folder = project
		? projectFolderPath(projectKeyFor(snapshot.files, project))
		: null;
	const inScope = (path: string) =>
		lineInScope({ path, meta: {} }, project) ||
		memoryPathScope(path).kind === "legacy";
	const listing = await saveHookListing(
		snapshot.files,
		message.text,
		deps.today(),
		(lines) => deps.similarity(userId, lines, message.text).catch(() => null),
		project,
	);
	const saveRun = () =>
		runOnUserModel(deps, {
			userId,
			kind: "save",
			sessionId,
			route,
			instructions: SAVE_HOOK_INSTRUCTIONS,
			prompt: saveHookPrompt({
				message: message.text.slice(0, 6000),
				memory: listing.lines.map(saveHookLine).join("\n"),
				whole: listing.whole,
				files: Object.keys(snapshot.files)
					.filter(
						(path) =>
							path.endsWith(".md") && path !== MEMORY_ENTRY && inScope(path),
					)
					.sort(),
				project: chat.project,
				folder,
			}),
			tools: {},
			maxSteps: 1,
			timeoutMs: SAVE_TIMEOUT_MS,
			// Every save of this user shares one prefix: instructions, then memory.
			cacheScope: `memory-save:${userId}`,
			deferRecord: true,
		});
	let run = await saveRun();
	// One retry for a failed call; a timeout or a step limit would only repeat.
	if (retryableSaveFailure(run.outcome)) {
		await (deps.sleep ?? delay)(SAVE_RETRY_DELAY_MS);
		run = await saveRun();
	}
	if (run.outcome !== "completed") return run.outcome;
	// Recorded once the save is done, whatever it found: a new chat waits for
	// this row (pendingMemorySaves), and ":nothing-new" lets its read side
	// stop showing the message at once.
	const finish = async <T extends string>(outcome: T, suffix = "") => {
		await run.record?.(suffix);
		return outcome;
	};
	// "replaces" names a line the model was shown; it is applied by its text.
	const shown = new Map(
		listing.lines.map((entry) => [`${entry.path}:${entry.line}`, entry.raw]),
	);
	const parsed = parseSaveHookAnswer(run.text).flatMap(
		({ replaces, personal, ...entry }): SaveHookEntry[] => {
			// A chat without a project keeps only notes about the user.
			const target = personal ? PERSONAL_FOLDER : folder;
			if (!target) return [];
			const raw = replaces && shown.get(`${replaces.path}:${replaces.line}`);
			return [
				{
					...entry,
					folder: target,
					...(raw ? { replaces: { path: replaces.path, raw } } : {}),
				},
			];
		},
	);
	const entries = await withoutNearDuplicates(
		parsed,
		memoryLines(snapshot.files).filter(
			(entry) =>
				entry.path !== MEMORY_ENTRY &&
				lineInScope(entry, project) &&
				!isRetired(entry.meta, deps.today()),
		),
		(lines, candidates) =>
			deps.closestLines(userId, lines, candidates).catch(() => null),
	);
	if (!entries.length) return finish("nothing-new", SAVE_NOTHING_OUTCOME);
	const source = chatSourceUrl(deps.appUrl, sessionId);
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const changes = saveHookChanges(snapshot.files, entries, {
				source,
				today: deps.today(),
				message: message.text,
				folder,
			});
			if (!changes.length)
				return await finish("nothing-new", SAVE_NOTHING_OUTCOME);
			const outcome = await repo.commit(
				snapshot,
				changes,
				`Remember from chat ${sessionId.slice(0, 8)} (save hook)`,
			);
			if (outcome.ok) {
				const after = withMemoryChanges(snapshot.files, changes);
				// The next chat's read hook finds these lines embedded already.
				await deps
					.warmLines(userId, newLineTexts(snapshot.files, after))
					.catch(() => console.warn("New memory lines could not be embedded."));
				await deps
					.recordSaved(
						userId,
						sessionId,
						message.id,
						savedMemoryLines(snapshot.files, after, sessionId),
					)
					.catch(() =>
						console.warn("Saved memory marker could not be recorded."),
					);
				return await finish("saved");
			}
			snapshot = await repo.snapshot();
		}
		return await finish("conflict", ":conflict");
	} catch (error) {
		await finish("failed", ":not-saved");
		throw error;
	}
}

const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A failed model call worth one more try: not a timeout or abort (those would repeat). */
export function retryableSaveFailure(outcome: string) {
	return (
		outcome.startsWith("failed:") && !/TimeoutError|AbortError/.test(outcome)
	);
}

export type SaveHookEntry = {
	/** Topic file name, without a folder. */
	file: string;
	text: string;
	/** `personal` or `projects/<key>`: where the entry goes (empty: the file as named). */
	folder?: string;
	/** An existing line (by its file and text) this entry replaces. */
	replaces?: { path: string; raw: string };
	/** "always": a rule every change follows (memory-repo.ts `scope: always`). */
	scope?: string;
};

/**
 * Entries that say what an existing line of this chat's scope already says
 * (isNearDuplicate) are dropped; a replacement never is. Without embeddings
 * every entry is kept and the substring check in saveHookChanges remains.
 */
export async function withoutNearDuplicates(
	entries: readonly SaveHookEntry[],
	lines: readonly MemoryLine[],
	closest: (
		lines: readonly MemoryLine[],
		entries: readonly { file: string; text: string }[],
	) => Promise<({ line: MemoryLine; similarity: number } | null)[] | null>,
): Promise<SaveHookEntry[]> {
	const fresh = entries.filter((entry) => !entry.replaces);
	if (!fresh.length || !lines.length) return [...entries];
	const found = await closest(lines, fresh);
	if (!found) return [...entries];
	const copies = new Set(
		fresh.filter((entry, index) => {
			const hit = found[index];
			return hit && isNearDuplicate(hit.similarity, hit.line.text, entry.text);
		}),
	);
	return entries.filter((entry) => !copies.has(entry));
}

/**
 * Appends each new entry to its folder's topic file, citing its chat, and
 * marks the line it replaces `superseded-by` that chat (the read side hides
 * it; a dream removes it). A replacement that would lose structured details
 * of the old line the user did not change (`droppedDetails`) leaves the old
 * line in place. An entry another line of its scope (personal/, the chat's
 * folder, or its own) already holds is skipped.
 */
export function saveHookChanges(
	files: MemoryFiles,
	entries: readonly SaveHookEntry[],
	context: {
		source: string;
		today: string;
		message?: string;
		/** The chat's project folder (`projects/<key>`), or null. */
		folder?: string | null;
	},
) {
	let working = files;
	const changed = new Set<string>();
	const lines = memoryLines(files);
	const known = (folder: string | undefined) => {
		const scope = new Set(
			[PERSONAL_FOLDER, context.folder, folder].filter(Boolean),
		);
		return lines
			.filter((entry) => {
				const own = memoryFolderOf(entry.path);
				return own === null || scope.has(own);
			})
			.map((entry) => entry.text.toLowerCase());
	};
	const added: string[] = [];
	for (const entry of entries) {
		if (entry.replaces) {
			const { path, raw } = entry.replaces;
			const content = working[path];
			const fileLines = content?.split("\n") ?? [];
			const index = fileLines.indexOf(raw);
			const old = parseMemoryLine(raw);
			const keeps =
				!old ||
				!droppedDetails(old.text, entry.text, context.message ?? "").length;
			if (content !== undefined && index >= 0 && keeps) {
				fileLines[index] = supersededLine(raw, context.source);
				working = withMemoryChanges(working, [
					{ path, content: fileLines.join("\n") },
				]);
				changed.add(path);
			}
		}
		const text = entry.text.toLowerCase();
		if (
			[...known(entry.folder), ...added].some((other) => other.includes(text))
		)
			continue;
		const appended = appendMemoryEntry(
			working,
			entry.folder ? `${entry.folder}/${entry.file}` : entry.file,
			memoryBullet(entry.text, {
				scope: entry.scope,
				source: context.source,
				added: context.today,
			}),
		);
		working = withMemoryChanges(working, appended);
		for (const change of appended) changed.add(change.path);
		added.push(text);
	}
	return [...changed].map((path) => ({
		path,
		content: working[path] ?? null,
	}));
}

/** Embedding texts of the lines in `after` that `before` did not have. */
export function newLineTexts(before: MemoryFiles, after: MemoryFiles) {
	const known = new Set(
		memoryLines(before).map((entry) => memoryLineEmbeddingText(entry)),
	);
	return memoryLines(after)
		.filter((entry) => entry.path !== MEMORY_ENTRY)
		.map((entry) => memoryLineEmbeddingText(entry))
		.filter((text) => !known.has(text));
}

const RELATED_LINES = 24;

/**
 * The memory lines the save hook sees (this chat's scope), so it can skip what is known and
 * replace what changed: the whole memory in file and line order when it fits
 * SAVE_HOOK_MEMORY_CHARS (a prefix that stays the same from one save to the
 * next, so the provider caches it), else the best matches for the message by
 * the read hook's ranking (cosine when embeddings are available, plus words
 * and topic file), still listed in file and line order. Index links and
 * retired lines are left out.
 */
export async function saveHookListing(
	files: MemoryFiles,
	message: string,
	today: string,
	similarity: (
		lines: readonly MemoryLine[],
	) => Promise<Map<MemoryLine, number> | null>,
	/** Only this chat's scope (personal/ and its project's folder) is listed; undefined: all. */
	project?: MemoryProject | null,
): Promise<{ lines: MemoryLine[]; whole: boolean }> {
	const lines = memoryLines(
		withMemoryChanges(files, withoutExpired(files, today)),
	)
		.filter(
			(entry) =>
				!/^\[\[[^\]]+\]\]$/.test(entry.text) &&
				(project === undefined ||
					(entry.path === MEMORY_ENTRY
						? !entry.meta.project?.trim() ||
							Boolean(
								project && projectNameMatches(entry.meta.project, project),
							)
						: lineInScope(entry, project))),
		)
		.sort(byFileAndLine);
	if (!lines.length) return { lines: [], whole: true };
	const size = lines.reduce(
		(total, entry) => total + saveHookLine(entry).length + 1,
		0,
	);
	if (size <= SAVE_HOOK_MEMORY_CHARS) return { lines, whole: true };
	const cosine = await similarity(lines);
	const lexical = lexicalScores(lines, message);
	const scores = cosine ? memoryMatchScores(lines, cosine, message) : lexical;
	return {
		lines: lines
			.filter((entry) => cosine || (lexical.get(entry) ?? 0) > 0)
			.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
			.slice(0, RELATED_LINES)
			.sort(byFileAndLine),
		whole: false,
	};
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
		project: chat.project,
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
	return clip(text, SOURCE_CHARS);
}

/** The dreamer's tools over a writable copy of the repo; nothing is pushed until commit. */
function dreamTools(input: {
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

/** Lines the read hook has long not used, for the review to retire; none when unknown. */
async function staleLines(
	deps: MemoryJobDeps,
	userId: string,
	files: MemoryFiles,
) {
	try {
		const texts = memoryLines(files)
			.filter((entry) => entry.path !== MEMORY_ENTRY)
			.map((entry) => entry.text);
		const { recalled, since } = await deps.recalls(userId, texts);
		return staleMemoryLines({
			files,
			today: deps.today(),
			recalled,
			trackingSince: since,
		});
	} catch {
		return [];
	}
}

function dreamChanges(before: MemoryFiles, after: MemoryFiles): MemoryChange[] {
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
	const projects = await deps.projects(userId).catch(() => []);
	const snapshot: MemorySnapshot = await memoryInLayout(
		repo,
		async () => projects,
	);
	const working: MemoryFiles =
		mode === "full"
			? withMemoryChanges(
					snapshot.files,
					withoutExpired(snapshot.files, deps.today()),
				)
			: { ...snapshot.files };
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
	const last =
		mode === "full" ? await deps.lastReview(userId).catch(() => null) : null;
	// Right after the move into the layout, the next dream sorts personal/.
	const sorting = mode === "full" && personalSortPending(working);
	const reviewing =
		sorting ||
		(mode === "full" &&
			(!last ||
				Date.parse(`${deps.today()}T00:00:00Z`) - last.getTime() >=
					DREAM_REVIEW_DAYS * 86_400_000));
	const review = reviewing
		? dreamReviewSection(working, {
				// A different project folder leads each week's review.
				rotate: Math.floor(
					Date.parse(`${deps.today()}T00:00:00Z`) /
						(DREAM_REVIEW_DAYS * 86_400_000),
				),
				stale: await staleLines(deps, userId, working),
			})
		: null;
	const listing = Object.entries(working)
		.filter(([path]) => path.endsWith(".md"))
		.map(([path, content]) => `${path} (${content.split("\n").length} lines)`)
		.join("\n");
	const folders = projectFolderListing(working, projects);
	const run = await runOnUserModel(deps, {
		userId,
		kind: "dream",
		sessionId: null,
		route,
		instructions: dreamInstructions(mode, deps.today()),
		prompt: `New chats since the last dream:\n\n${renderDreamInbox(inboxChats)}\n\nProject folders:\n${folders || "(none yet)"}\n\nMemory files:\n${listing || "(empty repo)"}\n\nMEMORY.md:\n${working[MEMORY_ENTRY] ?? "(missing)"}${review ? `\n\n${review}` : ""}`,
		tools,
		maxSteps: review ? Math.max(maxSteps, REVIEW_MAX_STEPS) : maxSteps,
		outcomeSuffix: review ? DREAM_REVIEW_OUTCOME : undefined,
		endTurnTools: ["commit"],
		timeoutMs: DREAM_TIMEOUT_MS,
	});
	if (run.outcome === "no-route") return "no-route";
	if (message === null) {
		// The inbox is spent either way, so a stuck dream never bills twice.
		await deps.markDreamed(userId, through);
		return "incomplete";
	}
	// A finished review sorted personal/: the marker stops asking for it.
	if (sorting && review?.includes("### personal/"))
		working[MEMORY_LAYOUT_MARKER] = layoutMarker(false);
	const changes = dreamChanges(snapshot.files, working);
	if (changes.length) {
		const outcome = await repo.commit(
			snapshot,
			changes,
			`${DREAM_COMMIT_PREFIX}${String(message).slice(0, 200)}`,
		);
		if (!outcome.ok) return "conflict";
		await deps
			.warmLines(userId, newLineTexts(snapshot.files, working))
			.catch(() => console.warn("New memory lines could not be embedded."));
	}
	await deps.markDreamed(userId, through);
	return changes.length ? "committed" : "unchanged";
}
