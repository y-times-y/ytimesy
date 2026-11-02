import type { ModelMessage } from "ai";
import { isUserRequestMessage } from "#/domain/api-conversation";
import {
	checkerStandingRules,
	reviewBriefRequest,
} from "#/domain/checker-brief";
import {
	DEFAULT_HARNESS_VARIANT,
	type MemoryWording,
	type MemoryWriter,
} from "#/domain/harness-variant";
import {
	byRecency,
	lineInScope,
	type MemoryProject,
	memoryIndexFor,
	memoryProjectKey,
	projectFolderPath,
} from "#/domain/memory-layout";
import {
	currentMemoryRecall,
	type MemoryReadHookOutcome,
	type MemoryRecall,
	type RecalledChatMessage,
	recalledMemoryLine,
	savedMemoryLines,
	withSavedMemory,
} from "#/domain/memory-marker";
import { memoryMatchScores } from "#/domain/memory-ranking";
import {
	annotateMemoryText,
	attachedMemory,
	chatIdFromSource,
	chatSourceUrl,
	cosineSimilarity,
	EMPTY_MEMORY,
	entryPaths,
	MEMORY_CHECKER_RULES_HEADER,
	MEMORY_ENTRY,
	MEMORY_MATCH_LATER_LIMIT,
	MEMORY_MATCH_LIMIT,
	type MemoryLine,
	type MemoryMode,
	memoryAppUrl,
	memoryCloneScript,
	memoryEntryPart,
	memoryIndexShown,
	memoryInstructions,
	memoryLineEmbeddingText,
	memoryLineShown,
	memoryLines,
	memoryMatchesPart,
	memoryPart,
	memoryQueryText,
	memoryRecentLine,
	memoryRecentPart,
	memoryRulesPart,
	memoryToday,
	projectRuleLine,
	projectRules,
	projectRulesShown,
	SCRUB_MEMORY_CREDENTIAL,
	selectMemoryMatches,
	withMemoryParts,
} from "#/domain/memory-repo";
import { MODEL_WORKFLOW_DEADLINE_MS } from "#/domain/model-workflow";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { SessionItem } from "#/domain/session-item";
import type { SubagentRole } from "#/domain/subagent";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import {
	cachedLineEmbeddings,
	type Embed,
	type LineEmbeddingStats,
	memoryEmbedder,
} from "../adapters/memory-embeddings";
import {
	type MemoryRepo,
	type MemorySnapshot,
	memoryRepo,
	memoryRepoName,
} from "../adapters/memory-repos";
import {
	memoryChatTitles,
	memoryProject,
	memorySettings,
	pendingMemorySaves,
	type RecentChatMessage,
	recentUnsavedMessages,
	recordMemoryRecalls,
} from "../adapters/memory-settings";
import {
	type MemoryVmTokenLedger,
	memoryVmTokens,
} from "../adapters/memory-vm-tokens";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/**
 * The VM's Git token outlives any single durable step (each step mints a new
 * one) by a few minutes; every step's end, however the step ends, revokes it
 * and removes it from the clone sooner.
 */
const VM_TOKEN_TTL_SECONDS = MODEL_WORKFLOW_DEADLINE_MS / 1000 + 5 * 60;
/**
 * The read hook's budget before the first model call. A chat's first request
 * waits longer: its VM is still starting, and a late recall beats none.
 */
const READ_HOOK_TIMEOUT_MS = 6000;
const FIRST_READ_HOOK_TIMEOUT_MS = 12_000;
/** Bounds embedding work on a turn; larger memories embed over several turns. */
const MAX_EMBEDDED_LINES = 400;
/**
 * Another chat's latest message stays attached until the save hook shows a
 * saved line for it, for at most this long (the hook runs within seconds).
 */
const RECENT_WINDOW_SECONDS = 600;
const RECENT_TIMEOUT_MS = 3000;
/**
 * A save hook still running for another chat's last turn is waited for this
 * long, so what the user said there is read as a saved line; past it, the
 * recent messages above stand in for it.
 */
const SAVE_WAIT_MS = 4000;
const SAVE_POLL_MS = 500;
const SAVE_WAIT_WINDOW_SECONDS = 120;
/** Reading what a turn saved never holds up its completion for long. */
const SAVED_LINES_TIMEOUT_MS = 5000;

export type TurnMemoryOwner = {
	id: string;
	userId: string;
	projectId: string | null;
};

export type TurnMemory = {
	mode: Exclude<MemoryMode, "off">;
	/** Builder system-prompt addition; fixed for the chat. */
	instructions: string;
	/**
	 * Clone or refresh ~/memory on the VM with a fresh short-lived token.
	 * `beforeVm` gets the token before it reaches the VM, so whoever redacts
	 * tool and hook output need not wait for the clone.
	 */
	prepareVm(
		workspace: AgentToolWorkspace,
		beforeVm?: (token: string) => void,
	): Promise<void>;
	/** Tokens prepareVm put on the VM, for tool-result redaction. */
	vmTokens(): readonly string[];
	/**
	 * Removes the token from the clone (when this step has the VM) and
	 * revokes every token this chat's steps put on a VM, whichever isolate
	 * minted it; never fails.
	 */
	releaseVm(workspace?: AgentToolWorkspace): Promise<void>;
	/**
	 * MEMORY.md at chat start and the read hook, attached to the current
	 * request; `recall` is what the chat shows of it (null when memory was
	 * not read, or a resumed step already attached it).
	 */
	attach(
		messages: ModelMessage[],
		items: readonly SessionItem[],
		workspace: () => Promise<AgentToolWorkspace>,
	): Promise<{ messages: ModelMessage[]; recall: MemoryRecall | null }>;
	/** Adds a marker for the lines this chat saved since the request's recall. */
	recordSaved(
		items: readonly SessionItem[],
		turnId: string,
	): Promise<SessionItem[]>;
	/** The save hook: queued after a completed turn (full mode, unless the agent alone writes). */
	afterTurn(turnId: string): Promise<void>;
};

type MemoryOptions = {
	appUrl?: string;
	repo?: MemoryRepo | null;
	embed?: Embed | null;
	today?: () => string;
	/** The chat's project (its repository ids pick its memory folder); looked up when absent. */
	project?: MemoryProject | null;
	chatTitles?: (ids: readonly string[]) => Promise<Map<string, string>>;
	/** Notes which lines were attached, for dreams to retire unused ones; never awaited by a turn. */
	recordRecalls?: (texts: readonly string[]) => Promise<void>;
	/** Development harness variant: how recalled memory is presented. */
	wording?: MemoryWording;
};

/**
 * What a turn reads memory from: the user's settings and repo, and the
 * memory snapshot with its line vectors (warm in this isolate, else the
 * database, else embedded once), prefetched with the turn's setup so the read
 * hook before the first model call usually only embeds the message. Null when
 * memory is off or unavailable.
 */
async function memorySource(owner: TurnMemoryOwner, options: MemoryOptions) {
	const settings = await memorySettings(owner.userId).catch((error) => {
		console.warn("Memory settings are unavailable; memory is off.", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	});
	const mode = settings?.mode ?? "off";
	if (mode === "off") return null;
	const repo =
		options.repo === undefined
			? memoryRepo(memoryRepoName(owner.userId, settings?.repo))
			: options.repo;
	if (!repo) return null;
	const embed = options.embed === undefined ? memoryEmbedder() : options.embed;
	const setupStarted = Date.now();
	let prefetched: Prefetched | null | undefined;
	// Independent: the snapshot and the project that scopes it.
	const projectLookup: Promise<MemoryProject | null> =
		options.project !== undefined
			? Promise.resolve(options.project)
			: owner.projectId
				? memoryProject(owner.userId, owner.projectId).catch(() => null)
				: Promise.resolve(null);
	const prefetching = Promise.all([repo.snapshot(), projectLookup])
		.then(([snapshot, project]) => {
			const snapshotMs = Date.now() - setupStarted;
			const stats = emptyEmbeddingStats();
			const vectors =
				mode === "full" && embed
					? cachedLineEmbeddings(
							owner.userId,
							recallableLines(snapshot, project).map(memoryLineEmbeddingText),
							embed,
							undefined,
							{ stats, saveInBackground: true },
						)
					: null;
			vectors?.catch(() => {});
			prefetched = { snapshot, vectors, snapshotMs, stats };
			return prefetched;
		})
		.catch((error) => {
			console.warn("Memory could not be read.", {
				error: error instanceof Error ? error.name : "unknown",
			});
			prefetched = null;
			return null;
		});
	const project = await projectLookup;
	const chatTitles =
		options.chatTitles ??
		((ids: readonly string[]) => memoryChatTitles(owner.userId, ids));
	const recordRecalls =
		options.recordRecalls ??
		((texts: readonly string[]) => recordMemoryRecalls(owner.userId, texts));
	return {
		mode,
		repo,
		embed,
		project,
		today: options.today ?? memoryToday,
		/** Notes recalled lines in the background; a turn never waits on it. */
		noteRecalled(lines: readonly MemoryLine[]) {
			if (!lines.length) return;
			Promise.resolve()
				.then(() => recordRecalls(lines.map((entry) => entry.text)))
				.catch(() => {});
		},
		wording: options.wording ?? DEFAULT_HARNESS_VARIANT.memoryWording,
		/** The prefetched snapshot, and how long the request waited for it. */
		async loaded() {
			const started = Date.now();
			const loaded = prefetched === undefined ? await prefetching : prefetched;
			return loaded && { ...loaded, waitedMs: Date.now() - started };
		},
		/** The recalled lines as the chat shows them, with their source chats' titles. */
		async recalledLines(matches: readonly MemoryLine[]) {
			if (!matches.length) return [];
			const ids = matches.flatMap((entry) => {
				const id = entry.meta.source
					? chatIdFromSource(entry.meta.source)
					: null;
				return id ? [id] : [];
			});
			const titles = ids.length
				? await chatTitles(ids).catch(() => new Map<string, string>())
				: new Map<string, string>();
			return matches.map((entry) => recalledMemoryLine(entry, titles));
		},
	};
}

type Prefetched = {
	snapshot: MemorySnapshot;
	vectors: Promise<number[][]> | null;
	/** From the turn's setup to the snapshot's arrival. */
	snapshotMs: number;
	/** Where the prefetch's line vectors came from. */
	stats: LineEmbeddingStats;
};

/**
 * Cross-chat memory for one root builder turn, or null when memory is off or
 * unavailable. Memory never fails a turn: every step degrades to nothing.
 */
export async function turnMemory(
	owner: TurnMemoryOwner,
	options: MemoryOptions & {
		/** Development harness variant: agent = no save hook after turns. */
		writer?: MemoryWriter;
		/** The user's latest messages in other chats that memory may not hold yet. */
		recentMessages?: () => Promise<readonly RecentChatMessage[]>;
		/** How many of the user's other chats have a save hook still to finish. */
		pendingSaves?: () => Promise<number>;
		/** Where the ids of tokens put on a VM are kept for revocation. */
		vmTokenLedger?: MemoryVmTokenLedger;
	} = {},
): Promise<TurnMemory | null> {
	const source = await memorySource(owner, options);
	if (!source) return null;
	const { mode, repo, embed, project, today, wording } = source;
	const writer = options.writer ?? DEFAULT_HARNESS_VARIANT.memoryWriter;
	const url = chatSourceUrl(options.appUrl ?? memoryAppUrl(), owner.id);
	const recentMessages =
		options.recentMessages ??
		(() =>
			recentUnsavedMessages(
				owner.userId,
				owner.id,
				RECENT_WINDOW_SECONDS,
				owner.projectId,
			));
	const pendingSaves =
		options.pendingSaves ??
		(() =>
			pendingMemorySaves(owner.userId, owner.id, SAVE_WAIT_WINDOW_SECONDS));
	const vmTokens: string[] = [];
	/** Ids this isolate already revoked, and the id of each token it minted. */
	const revokedIds = new Set<string>();
	const minted = new Map<string, string>();
	const ledger = options.vmTokenLedger ?? memoryVmTokens;
	return {
		mode,
		instructions: memoryInstructions(
			mode,
			{
				url,
				project: project?.fullName ?? null,
				folder: project ? projectFolderPath(memoryProjectKey(project)) : null,
			},
			wording,
			writer,
		),
		async prepareVm(workspace, beforeVm) {
			try {
				const credentials = await repo.credentials(VM_TOKEN_TTL_SECONDS);
				// Recorded before it reaches the VM, so any isolate can revoke it;
				// a token that cannot be recorded never goes there.
				if (credentials.tokenId)
					try {
						await ledger.record({
							tokenId: credentials.tokenId,
							userId: owner.userId,
							sessionId: owner.id,
							repo: repo.name,
							expiresAt: new Date(Date.now() + VM_TOKEN_TTL_SECONDS * 1000),
						});
					} catch (error) {
						await repo.revokeCredential?.(credentials.token).catch(() => {});
						throw error;
					}
				vmTokens.push(credentials.token);
				if (credentials.tokenId)
					minted.set(credentials.token, credentials.tokenId);
				beforeVm?.(credentials.token);
				const result = await workspace.machines.exec(
					workspace.vm,
					memoryCloneScript(credentials),
					60_000,
				);
				if (result.exitCode !== 0)
					console.warn("Memory clone failed on the VM.", {
						exitCode: result.exitCode,
					});
			} catch (error) {
				console.warn("Memory clone could not start.", {
					error: error instanceof Error ? error.name : "unknown",
				});
			}
		},
		vmTokens: () => vmTokens,
		async releaseVm(workspace) {
			const tokens = vmTokens.splice(0);
			// Earlier steps' tokens, possibly minted in another isolate.
			const recorded = await ledger
				.open(owner.userId, owner.id)
				.catch(() => [] as string[]);
			const localIds = tokens.flatMap((token) => {
				const id = minted.get(token);
				minted.delete(token);
				return id ? [id] : [];
			});
			const others = recorded.filter(
				(id) => !localIds.includes(id) && !revokedIds.has(id),
			);
			if (!tokens.length && !others.length) return;
			if (workspace && tokens.length) {
				const scrubbed = await workspace.machines
					.exec(workspace.vm, SCRUB_MEMORY_CREDENTIAL, 15_000)
					.catch(() => null);
				if (scrubbed?.exitCode !== 0)
					console.warn("Memory token could not be removed from the VM.");
			}
			try {
				await Promise.all([
					...tokens.map((token) => repo.revokeCredential?.(token)),
					...others.map((id) => repo.revokeCredential?.(id)),
				]);
				for (const id of [...localIds, ...others]) revokedIds.add(id);
				await ledger.revoked(owner.userId, [...localIds, ...others]);
			} catch {
				console.warn("Memory token could not be revoked; it expires soon.");
			}
		},
		async attach(messages, items, workspace) {
			const unchanged = { messages, recall: null };
			const at = currentRequestIndex(messages, items);
			if (at < 0) return unchanged;
			const current = messages[at];
			// A resumed step replays the parts it already attached.
			if (attachedMemory([current]).length) return unchanged;
			const loaded = await source.loaded();
			if (!loaded) return unchanged;
			let { snapshot, vectors } = loaded;
			const spans: Record<string, number> = {
				snapshotMs: loaded.snapshotMs,
				prefetchWaitMs: loaded.waitedMs,
			};
			// A save that finishes while this waits is read here, not missed.
			if (mode === "full" && writer !== "agent") {
				const waitStarted = Date.now();
				const waited = await waitForPendingSaves(pendingSaves);
				spans.saveWaitMs = Date.now() - waitStarted;
				if (waited) {
					const started = Date.now();
					const latest = await repo.snapshot().catch(() => null);
					spans.resnapshotMs = Date.now() - started;
					if (latest && latest.head !== snapshot.head) {
						snapshot = latest;
						// Lines the prefetch is still embedding are shared, not redone.
						vectors = null;
					}
				}
			}
			const shown = attachedMemory(messages).join("\n");
			const firstMessage =
				items.filter((item) => item.kind === "userMessage").length === 1;
			const firstRequest = firstMessage && !memoryIndexShown(shown);
			const rawEntry = snapshot.files[MEMORY_ENTRY];
			// MEMORY.md as this chat sees it: other projects' links and lines out, capped.
			const index =
				rawEntry !== undefined && rawEntry.trim() !== EMPTY_MEMORY.trim()
					? memoryIndexFor(rawEntry, project)
					: null;
			const entry = index?.content;
			const showEntry =
				firstRequest && entry !== undefined && Boolean(entry.trim());
			const rules =
				mode === "full" && firstMessage && !projectRulesShown(shown)
					? projectRules({
							lines: scopedLines(snapshot, project),
							today: today(),
						})
					: [];
			const rulesPart = rules.length ? memoryRulesPart(rules, wording) : null;
			const inContext = rulesPart ? `${shown}\n${rulesPart}` : shown;
			// Freshness without a model call: what the user just said in another
			// chat of this project, while its save hook may still be running.
			const recent =
				mode === "full" && writer !== "agent"
					? recentLines(recentMessages, shown)
					: Promise.resolve([]);
			const hook =
				mode === "full" && embed
					? await readHook({
							snapshot,
							embed,
							vectors: vectors ?? undefined,
							vectorStats: vectors ? loaded.stats : undefined,
							userId: owner.userId,
							query: latestUserText(items),
							alreadyShown: (raw) =>
								memoryLineShown(raw, inContext) ||
								(showEntry && (entry ?? "").includes(raw)),
							today: today(),
							project,
							limit: firstMessage
								? MEMORY_MATCH_LIMIT
								: MEMORY_MATCH_LATER_LIMIT,
							timeoutMs: firstMessage
								? FIRST_READ_HOOK_TIMEOUT_MS
								: READ_HOOK_TIMEOUT_MS,
						})
					: null;
			const matches = hook?.lines ?? [];
			source.noteRecalled([...rules, ...matches]);
			// Independent of each other: the source chats' titles, the other
			// chats' recent messages and the checkout's missing paths.
			const afterStarted = Date.now();
			const [lines, fresh, missing] = await Promise.all([
				source
					.recalledLines([...rules, ...matches])
					.then((recalled) => markedRules(recalled, rules.length)),
				recent,
				mode === "full" && (showEntry || matches.length)
					? missingPaths(
							[
								...(showEntry
									? memoryLines({ [MEMORY_ENTRY]: entry ?? "" })
									: []),
								...matches,
							],
							workspace,
						)
					: Promise.resolve(new Set<string>()),
			]);
			spans.afterHookMs = Date.now() - afterStarted;
			const recall: MemoryRecall = {
				head: snapshot.head,
				...(showEntry
					? { index: true as const, indexLines: index?.lines ?? 0 }
					: {}),
				lines,
				...(fresh.length ? { recent: fresh.map((item) => item.recalled) } : {}),
				...(hook ? { hook: recalledHook(hook, spans) } : {}),
			};
			if (!showEntry && !rulesPart && !matches.length && !fresh.length)
				return { messages, recall };
			const parts = [
				...(showEntry
					? [
							memoryEntryPart(
								mode === "full"
									? annotateMemoryText(entry ?? "", {
											today: today(),
											missingPaths: missing,
										})
									: (entry ?? ""),
								wording,
							),
						]
					: []),
				...(rulesPart ? [rulesPart] : []),
				...(matches.length
					? [memoryMatchesPart(matches, missing, wording)]
					: []),
				...(fresh.length
					? [
							memoryRecentPart(
								fresh.map((item) => item.line),
								wording,
							),
						]
					: []),
			];
			const next = [...messages];
			next[at] = withMemoryParts(
				current as { role: "user"; content: string },
				parts,
			) as ModelMessage;
			return { messages: next, recall };
		},
		async recordSaved(items, turnId) {
			const recall = currentMemoryRecall(items);
			let user = items.length - 1;
			while (user >= 0 && items[user].kind !== "userMessage") user--;
			if (!recall || user < 0) return [...items];
			let timer: ReturnType<typeof setTimeout> | undefined;
			const work = (async () => {
				const after = await repo.snapshot();
				if (after.head === recall.head) return [...items];
				const before = recall.head
					? await repo.snapshotAt(recall.head)
					: { head: null, files: {} };
				return withSavedMemory(
					items,
					items[user].id,
					`${turnId}:memory-saved`,
					savedMemoryLines(before.files, after.files, owner.id),
				);
			})();
			try {
				return await Promise.race([
					work,
					new Promise<SessionItem[]>((resolve) => {
						timer = setTimeout(
							() => resolve([...items]),
							SAVED_LINES_TIMEOUT_MS,
						);
					}),
				]);
			} catch (error) {
				console.warn("Saved memory could not be read.", {
					error: error instanceof Error ? error.name : "unknown",
				});
				return [...items];
			} finally {
				clearTimeout(timer);
				work.catch(() => {});
			}
		},
		async afterTurn(turnId) {
			if (mode !== "full" || writer === "agent") return;
			await dispatchBackgroundJob({
				id: backgroundJobId(`memory-save:${turnId}`),
				kind: "memory",
				action: "save",
				userId: owner.userId,
				sessionId: owner.id,
			}).catch((error) => {
				console.warn("Memory save hook could not be queued.", {
					error: error instanceof Error ? error.name : "unknown",
				});
			});
		},
	};
}

export type SubagentMemory = {
	/**
	 * The project's always-on rules on the child's first request, and the read
	 * hook's lines for its brief (a checker's: the user's request) on each
	 * request, as extra parts of that request. Read only: a child has no save
	 * hook, no ~/memory clone and no memory instructions; only the root chat
	 * curates memory.
	 */
	attach(
		messages: ModelMessage[],
		items: readonly SessionItem[],
	): Promise<{ messages: ModelMessage[]; recall: MemoryRecall | null }>;
};

/**
 * The project's memory for a subagent (writer, researcher, reviewer, the
 * fusion sidekick or the checker), read only, or null when memory is off,
 * unavailable or not in full mode.
 */
export async function subagentMemory(
	owner: TurnMemoryOwner & { role: SubagentRole },
	options: MemoryOptions = {},
): Promise<SubagentMemory | null> {
	const source = await memorySource(owner, options);
	if (source?.mode !== "full") return null;
	const { embed, project, today, wording } = source;
	const checker = owner.role === "checker";
	return {
		async attach(messages, items) {
			const unchanged = { messages, recall: null };
			const index = currentRequestIndex(messages, items);
			if (index < 0) return unchanged;
			const current = messages[index];
			if (attachedMemory([current]).length) return unchanged;
			const loaded = await source.loaded();
			if (!loaded) return unchanged;
			const { snapshot, vectors } = loaded;
			// An empty memory (for this project) leaves the child's request as it was.
			if (!recallableLines(snapshot, project).length) return unchanged;
			const spans: Record<string, number> = {
				snapshotMs: loaded.snapshotMs,
				prefetchWaitMs: loaded.waitedMs,
			};
			const shown = attachedMemory(messages).join("\n");
			const firstMessage =
				items.filter((item) => item.kind === "userMessage").length === 1;
			const rules =
				firstMessage && !projectRulesShown(shown)
					? projectRules({
							lines: scopedLines(snapshot, project),
							today: today(),
						})
					: [];
			const rulesPart = rules.length
				? checker
					? null
					: memoryRulesPart(rules, wording)
				: null;
			const inContext = rulesPart
				? `${shown}\n${rulesPart}`
				: `${shown}\n${rules.map((entry) => `${projectRuleLine(entry)}\n`).join("")}`;
			const brief = latestUserText(items);
			const hook = embed
				? await readHook({
						snapshot,
						embed,
						vectors: vectors ?? undefined,
						vectorStats: vectors ? loaded.stats : undefined,
						userId: owner.userId,
						// A checker's brief is generic; its request is what to recall for.
						query: (checker ? reviewBriefRequest(brief) : null) ?? brief,
						alreadyShown: (raw) => memoryLineShown(raw, inContext),
						today: today(),
						project,
						limit: firstMessage ? MEMORY_MATCH_LIMIT : MEMORY_MATCH_LATER_LIMIT,
						timeoutMs: firstMessage
							? FIRST_READ_HOOK_TIMEOUT_MS
							: READ_HOOK_TIMEOUT_MS,
					})
				: null;
			const matches = hook?.lines ?? [];
			const recall: MemoryRecall = {
				head: snapshot.head,
				lines: markedRules(
					await source.recalledLines([...rules, ...matches]),
					rules.length,
				),
				...(hook ? { hook: recalledHook(hook, spans) } : {}),
			};
			if (!rules.length && !matches.length) return { messages, recall };
			const parts = checker
				? [
						memoryPart(
							`${MEMORY_CHECKER_RULES_HEADER}\n${checkerStandingRules({
								rules: rules.map((entry) => entry.text),
								related: matches.map((entry) => `- ${entry.raw.trim()}`),
							})}`,
						),
					]
				: [
						...(rulesPart ? [rulesPart] : []),
						...(matches.length
							? [memoryMatchesPart(matches, new Set(), wording)]
							: []),
					];
			const next = [...messages];
			next[index] = withMemoryParts(
				current as { role: "user"; content: string },
				parts,
			) as ModelMessage;
			return { messages: next, recall };
		},
	};
}

/** Recalled lines with the first `count` (the project's rules) marked as rules. */
function markedRules<T extends object>(lines: readonly T[], count: number) {
	return lines.map((line, index) =>
		index < count ? { ...line, rule: true as const } : line,
	);
}

/** The recall's record of an attached message: shorter than what the model saw. */
const RECENT_SHOWN_CHARS = 280;

/**
 * Recent messages as attached lines (with what the chat shows of each),
 * minus any already attached in this chat; never fails.
 */
async function recentLines(
	load: () => Promise<readonly RecentChatMessage[]>,
	shown: string,
): Promise<{ line: string; recalled: RecalledChatMessage }[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const work = Promise.resolve().then(load);
	try {
		const messages = await Promise.race([
			work,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), RECENT_TIMEOUT_MS);
			}),
		]);
		if (!messages) {
			console.warn("Recent chat messages for memory timed out.", {
				ms: RECENT_TIMEOUT_MS,
			});
			return [];
		}
		return messages.flatMap((message) => {
			const line = memoryRecentLine(message);
			if (shown.includes(line)) return [];
			const text = message.text.replaceAll(/\s+/g, " ").trim();
			return [
				{
					line,
					recalled: {
						chatId: message.sessionId,
						...(message.title.trim() ? { title: message.title.trim() } : {}),
						text:
							text.length > RECENT_SHOWN_CHARS
								? `${text.slice(0, RECENT_SHOWN_CHARS - 1)}…`
								: text,
					},
				},
			];
		});
	} catch (error) {
		console.warn("Recent chat messages could not be read for memory.", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return [];
	} finally {
		clearTimeout(timer);
		work.catch(() => {});
	}
}

/**
 * Waits up to SAVE_WAIT_MS for other chats' pending save hooks; whether
 * there were any, so memory is worth reading again. Never fails.
 */
async function waitForPendingSaves(pending: () => Promise<number>) {
	const deadline = Date.now() + SAVE_WAIT_MS;
	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));
	const ask = async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const work = Promise.resolve().then(pending);
		try {
			return await Promise.race([
				work,
				new Promise<null>((resolve) => {
					timer = setTimeout(
						() => resolve(null),
						Math.max(0, deadline - Date.now()),
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			work.catch(() => {});
		}
	};
	try {
		if (!(await ask())) return false;
		while (Date.now() + SAVE_POLL_MS < deadline) {
			await sleep(SAVE_POLL_MS);
			if ((await ask()) === 0) return true;
		}
		console.warn("Memory saves of other chats were still running.", {
			ms: SAVE_WAIT_MS,
		});
		return true;
	} catch (error) {
		console.warn("Pending memory saves could not be read.", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return false;
	}
}

function currentRequestIndex(
	messages: readonly ModelMessage[],
	items: readonly SessionItem[],
) {
	for (let index = messages.length - 1; index >= 0; index--)
		if (isUserRequestMessage(items, messages[index])) return index;
	return -1;
}

function latestUserText(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage") return item.text;
	}
	return "";
}

/**
 * Every topic-file entry in this chat's scope: personal/ and its project's
 * folder (project-less chats: personal/ only), plus untagged legacy lines
 * until the layout migration moves them. MEMORY.md is attached on its own.
 */
export function scopedLines(
	snapshot: MemorySnapshot,
	project: MemoryProject | null,
) {
	return memoryLines(snapshot.files).filter(
		(entry) => entry.path !== MEMORY_ENTRY && lineInScope(entry, project),
	);
}

/** The lines the read hook ranks: this chat's scope, newest first, at most MAX_EMBEDDED_LINES. */
export function recallableLines(
	snapshot: MemorySnapshot,
	project: MemoryProject | null,
) {
	return scopedLines(snapshot, project)
		.sort(byRecency)
		.slice(0, MAX_EMBEDDED_LINES);
}

export type ReadHookResult = {
	lines: MemoryLine[];
	outcome: MemoryReadHookOutcome;
	ms: number;
	/** The error's name, for outcome "error". */
	error?: string;
	/** Where the hook's time went (ms, and line counts by vector source). */
	spans?: Record<string, number>;
};

/**
 * The query is embedded again when the first call has not answered by then
 * (the median call takes about 0.3 s; a slow one took several), or at once
 * when it fails; the first answer wins.
 */
const QUERY_HEDGE_MS = 1500;

/** One embedding of the query, hedged with a second call (see QUERY_HEDGE_MS). */
export function hedgedQuery(
	embed: Embed,
	query: string,
	hedgeMs = QUERY_HEDGE_MS,
): Promise<{ vector: number[]; calls: number }> {
	return new Promise((resolve, reject) => {
		let calls = 0;
		let failed = 0;
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const call = () => {
			calls++;
			Promise.resolve()
				.then(() => embed.query(query))
				.then(
					(vector) => {
						if (done) return;
						done = true;
						clearTimeout(timer);
						resolve({ vector, calls });
					},
					(error) => {
						failed++;
						if (done) return;
						if (calls < 2) {
							clearTimeout(timer);
							call();
						} else if (failed >= calls) {
							done = true;
							reject(error);
						}
					},
				);
		};
		call();
		timer = setTimeout(() => {
			if (!done && calls < 2) call();
		}, hedgeMs);
	});
}

export function emptyEmbeddingStats(): LineEmbeddingStats {
	return { warm: 0, shared: 0, loaded: 0, loadMs: 0, embedded: 0, embedMs: 0 };
}

/** The read hook as a recall records it, with the request's own spans. */
function recalledHook(
	hook: ReadHookResult,
	spans: Record<string, number> = {},
): NonNullable<MemoryRecall["hook"]> {
	return {
		outcome: hook.outcome,
		ms: hook.ms,
		...(hook.error ? { error: hook.error } : {}),
		spans: { ...spans, ...hook.spans },
	};
}

/**
 * Supermemory-style recall: embed the message, rank this chat's lines by
 * cosine similarity merged with word overlap and its topic file's best hit
 * (memory-ranking.ts), keep the best few above the cutoff. Never throws: a
 * timeout or an error yields no lines and says which it was.
 */
export async function readHook(input: {
	snapshot: MemorySnapshot;
	embed: Embed;
	userId: string;
	query: string;
	alreadyShown: (raw: string) => boolean;
	today: string;
	/** The chat's project: only personal/ and its folder are recalled. */
	project: MemoryProject | null;
	/** Lines at most (MEMORY_MATCH_LIMIT by default). */
	limit?: number;
	/** The snapshot's line vectors when already loading (recallableLines order). */
	vectors?: Promise<number[][]>;
	/** Where those vectors come from, filled in as they load. */
	vectorStats?: LineEmbeddingStats;
	cache?: Parameters<typeof cachedLineEmbeddings>[3];
	timeoutMs?: number;
	hedgeMs?: number;
}): Promise<ReadHookResult> {
	const started = Date.now();
	const spans: Record<string, number> = {};
	const result = (
		outcome: MemoryReadHookOutcome,
		lines: MemoryLine[] = [],
		error?: string,
	): ReadHookResult => {
		const ms = Date.now() - started;
		return {
			lines,
			outcome,
			ms,
			...(error ? { error } : {}),
			...(Object.keys(spans).length ? { spans: { ...spans } } : {}),
		};
	};
	const query = memoryQueryText(input.query);
	if (!query) return result("skipped");
	const lines = recallableLines(input.snapshot, input.project);
	if (!lines.length) return result("none");
	const stats = input.vectors ? input.vectorStats : emptyEmbeddingStats();
	const work = (async () => {
		const [queried, vectors] = await Promise.all([
			hedgedQuery(input.embed, query, input.hedgeMs).then((answer) => {
				spans.queryMs = Date.now() - started;
				if (answer.calls > 1) spans.queryCalls = answer.calls;
				return answer.vector;
			}),
			(
				input.vectors ??
				cachedLineEmbeddings(
					input.userId,
					lines.map(memoryLineEmbeddingText),
					input.embed,
					input.cache,
					{ stats, saveInBackground: true },
				)
			).then((loaded) => {
				spans.vectorsMs = Date.now() - started;
				return loaded;
			}),
		]);
		const ranking = Date.now();
		const similarity = new Map(
			lines.map((entry, index) => [
				entry,
				cosineSimilarity(queried, vectors[index] ?? []),
			]),
		);
		const scores = memoryMatchScores(lines, similarity, query);
		const selected = selectMemoryMatches({
			lines,
			scores,
			alreadyShown: input.alreadyShown,
			today: input.today,
			query,
			limit: input.limit,
		});
		spans.rankMs = Date.now() - ranking;
		return selected;
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const matches = await Promise.race([
			work,
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(
					() => resolve("timeout"),
					input.timeoutMs ?? READ_HOOK_TIMEOUT_MS,
				);
			}),
		]);
		if (stats) Object.assign(spans, vectorSpans(stats));
		if (matches === "timeout") {
			console.warn("Memory read hook timed out.", {
				ms: Date.now() - started,
				lines: lines.length,
				spans,
			});
			return result("timeout");
		}
		const done = result(matches.length ? "matched" : "none", matches);
		if (done.ms >= SLOW_READ_HOOK_MS)
			console.warn("Memory read hook was slow.", {
				ms: done.ms,
				lines: lines.length,
				spans,
			});
		return done;
	} catch (error) {
		const name = error instanceof Error ? error.name : "unknown";
		console.warn("Memory read hook failed.", {
			error: name,
			message: error instanceof Error ? error.message.slice(0, 200) : "",
		});
		return result("error", [], name);
	} finally {
		clearTimeout(timer);
		work.catch(() => {});
	}
}

/** A read hook this slow logs where its time went. */
const SLOW_READ_HOOK_MS = 2000;

/** Line counts and times by vector source, for the hook's spans. */
function vectorSpans(stats: LineEmbeddingStats) {
	return Object.fromEntries(
		Object.entries({
			warmLines: stats.warm,
			sharedLines: stats.shared,
			loadedLines: stats.loaded,
			loadMs: stats.loadMs,
			embeddedLines: stats.embedded,
			embedMs: stats.embedMs,
		}).filter(([, value]) => value > 0),
	);
}

/** `paths:` of these entries that do not exist in the current checkout. */
async function missingPaths(
	entries: readonly MemoryLine[],
	workspace: () => Promise<AgentToolWorkspace>,
) {
	const paths = [
		...new Set(entries.flatMap((entry) => entryPaths(entry.meta))),
	];
	if (!paths.length) return new Set<string>();
	try {
		const { machines, vm, cwd } = await workspace();
		const result = await machines.exec(
			vm,
			`cd ${quote(cwd)} && for p in ${paths.map(quote).join(" ")}; do [ -e "$p" ] || printf '%s\\n' "$p"; done; true`,
			10_000,
		);
		return new Set(result.stdout.split("\n").filter(Boolean));
	} catch {
		return new Set<string>();
	}
}
