import type { ModelMessage } from "ai";
import { isUserRequestMessage } from "#/domain/api-conversation";
import {
	DEFAULT_HARNESS_VARIANT,
	type MemoryWording,
	type MemoryWriter,
} from "#/domain/harness-variant";
import {
	currentMemoryRecall,
	type MemoryReadHookOutcome,
	type MemoryRecall,
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
	MEMORY_ENTRY,
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
	memoryQueryText,
	memoryRecentLine,
	memoryRecentPart,
	memoryRulesPart,
	memoryToday,
	projectRules,
	projectRulesShown,
	SCRUB_MEMORY_CREDENTIAL,
	selectMemoryMatches,
	withMemoryParts,
} from "#/domain/memory-repo";
import { MODEL_WORKFLOW_DEADLINE_MS } from "#/domain/model-workflow";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { SessionItem } from "#/domain/session-item";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import {
	cachedLineEmbeddings,
	type Embed,
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
	memoryProjectName,
	memorySettings,
	pendingMemorySaves,
	type RecentChatMessage,
	recentUnsavedMessages,
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
	/** Clone or refresh ~/memory on the VM with a fresh short-lived token. */
	prepareVm(workspace: AgentToolWorkspace): Promise<void>;
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

/**
 * Cross-chat memory for one root builder turn, or null when memory is off or
 * unavailable. Memory never fails a turn: every step degrades to nothing.
 */
export async function turnMemory(
	owner: TurnMemoryOwner,
	options: {
		appUrl?: string;
		repo?: MemoryRepo | null;
		embed?: Embed | null;
		today?: () => string;
		projectName?: string | null;
		chatTitles?: (ids: readonly string[]) => Promise<Map<string, string>>;
		/** Development harness variant: how recalled memory is presented. */
		wording?: MemoryWording;
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
	const projectName =
		options.projectName !== undefined
			? options.projectName
			: owner.projectId
				? await memoryProjectName(owner.userId, owner.projectId).catch(
						() => null,
					)
				: null;
	const today = options.today ?? memoryToday;
	const wording = options.wording ?? DEFAULT_HARNESS_VARIANT.memoryWording;
	const writer = options.writer ?? DEFAULT_HARNESS_VARIANT.memoryWriter;
	const url = chatSourceUrl(options.appUrl ?? memoryAppUrl(), owner.id);
	const recentMessages =
		options.recentMessages ??
		(() =>
			recentUnsavedMessages(owner.userId, owner.id, RECENT_WINDOW_SECONDS));
	const pendingSaves =
		options.pendingSaves ??
		(() =>
			pendingMemorySaves(owner.userId, owner.id, SAVE_WAIT_WINDOW_SECONDS));
	const chatTitles =
		options.chatTitles ??
		((ids: readonly string[]) => memoryChatTitles(owner.userId, ids));
	/**
	 * Started with the turn's setup: the memory snapshot and its line vectors
	 * (warm in this isolate, else the database, else embedded once), so the
	 * read hook before the first model call usually only embeds the message.
	 */
	let prefetched:
		| { snapshot: MemorySnapshot; vectors: Promise<number[][]> | null }
		| null
		| undefined;
	const prefetching = repo
		.snapshot()
		.then((snapshot) => {
			const vectors =
				mode === "full" && embed
					? cachedLineEmbeddings(
							owner.userId,
							recallableLines(snapshot).map(memoryLineEmbeddingText),
							embed,
						)
					: null;
			vectors?.catch(() => {});
			prefetched = { snapshot, vectors };
			return prefetched;
		})
		.catch((error) => {
			console.warn("Memory could not be read.", {
				error: error instanceof Error ? error.name : "unknown",
			});
			prefetched = null;
			return null;
		});
	/** The recalled lines as the chat shows them, with their source chats' titles. */
	async function recalledLines(matches: readonly MemoryLine[]) {
		if (!matches.length) return [];
		const ids = matches.flatMap((entry) => {
			const id = entry.meta.source ? chatIdFromSource(entry.meta.source) : null;
			return id ? [id] : [];
		});
		const titles = ids.length
			? await chatTitles(ids).catch(() => new Map<string, string>())
			: new Map<string, string>();
		return matches.map((entry) => recalledMemoryLine(entry, titles));
	}
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
				project: projectName,
			},
			wording,
			writer,
		),
		async prepareVm(workspace) {
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
			const index = currentRequestIndex(messages, items);
			if (index < 0) return unchanged;
			const current = messages[index];
			// A resumed step replays the parts it already attached.
			if (attachedMemory([current]).length) return unchanged;
			const loaded = prefetched === undefined ? await prefetching : prefetched;
			if (!loaded) return unchanged;
			let { snapshot, vectors } = loaded;
			// A save that finishes while this waits is read here, not missed.
			if (
				mode === "full" &&
				writer !== "agent" &&
				(await waitForPendingSaves(pendingSaves))
			) {
				const latest = await repo.snapshot().catch(() => null);
				if (latest && latest.head !== snapshot.head) {
					snapshot = latest;
					vectors = null;
				}
			}
			const shown = attachedMemory(messages).join("\n");
			const firstMessage =
				items.filter((item) => item.kind === "userMessage").length === 1;
			const firstRequest = firstMessage && !memoryIndexShown(shown);
			const entry = snapshot.files[MEMORY_ENTRY];
			const showEntry =
				firstRequest &&
				entry !== undefined &&
				entry.trim() !== EMPTY_MEMORY.trim();
			const rules =
				mode === "full" && firstMessage && !projectRulesShown(shown)
					? projectRules({
							lines: recallableLines(snapshot),
							today: today(),
							project: projectName,
						})
					: [];
			const rulesPart = rules.length ? memoryRulesPart(rules, wording) : null;
			const inContext = rulesPart ? `${shown}\n${rulesPart}` : shown;
			// Freshness without a model call: what the user just said in another
			// chat, while its save hook may still be running.
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
							userId: owner.userId,
							query: latestUserText(items),
							alreadyShown: (raw) =>
								memoryLineShown(raw, inContext) ||
								(showEntry && (entry ?? "").includes(raw)),
							today: today(),
							project: projectName,
							timeoutMs: firstMessage
								? FIRST_READ_HOOK_TIMEOUT_MS
								: READ_HOOK_TIMEOUT_MS,
						})
					: null;
			const matches = hook?.lines ?? [];
			const recall: MemoryRecall = {
				head: snapshot.head,
				...(showEntry ? { index: true as const } : {}),
				lines: await recalledLines([...rules, ...matches]),
				...(hook
					? {
							hook: {
								outcome: hook.outcome,
								ms: hook.ms,
								...(hook.error ? { error: hook.error } : {}),
							},
						}
					: {}),
			};
			const fresh = await recent;
			if (!showEntry && !rulesPart && !matches.length && !fresh.length)
				return { messages, recall };
			const missing =
				mode === "full"
					? await missingPaths(
							[
								...(showEntry
									? memoryLines({ [MEMORY_ENTRY]: entry ?? "" })
									: []),
								...matches,
							],
							workspace,
						)
					: new Set<string>();
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
				...(fresh.length ? [memoryRecentPart(fresh, wording)] : []),
			];
			const next = [...messages];
			next[index] = withMemoryParts(
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

/** Recent messages as attached lines, minus any already attached in this chat; never fails. */
async function recentLines(
	load: () => Promise<readonly RecentChatMessage[]>,
	shown: string,
) {
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
		return messages
			.map(memoryRecentLine)
			.filter((line) => !shown.includes(line));
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

/** The lines the read hook ranks: every topic-file entry (MEMORY.md is attached whole). */
export function recallableLines(snapshot: MemorySnapshot) {
	return memoryLines(snapshot.files)
		.filter((entry) => entry.path !== MEMORY_ENTRY)
		.slice(0, MAX_EMBEDDED_LINES);
}

export type ReadHookResult = {
	lines: MemoryLine[];
	outcome: MemoryReadHookOutcome;
	ms: number;
	/** The error's name, for outcome "error". */
	error?: string;
};

/**
 * Supermemory-style recall: embed the message, rank every memory line by
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
	project: string | null;
	/** The snapshot's line vectors when already loading (recallableLines order). */
	vectors?: Promise<number[][]>;
	cache?: Parameters<typeof cachedLineEmbeddings>[3];
	timeoutMs?: number;
}): Promise<ReadHookResult> {
	const started = Date.now();
	const result = (
		outcome: MemoryReadHookOutcome,
		lines: MemoryLine[] = [],
		error?: string,
	): ReadHookResult => ({
		lines,
		outcome,
		ms: Date.now() - started,
		...(error ? { error } : {}),
	});
	const query = memoryQueryText(input.query);
	if (!query) return result("skipped");
	const lines = recallableLines(input.snapshot);
	if (!lines.length) return result("none");
	const work = (async () => {
		const [queryVector, vectors] = await Promise.all([
			// One retry: a single slow or failed embedding call should not cost the recall.
			input.embed.query(query).catch(() => input.embed.query(query)),
			input.vectors ??
				cachedLineEmbeddings(
					input.userId,
					lines.map(memoryLineEmbeddingText),
					input.embed,
					input.cache,
				),
		]);
		const similarity = new Map(
			lines.map((entry, index) => [
				entry,
				cosineSimilarity(queryVector, vectors[index] ?? []),
			]),
		);
		const scores = memoryMatchScores(lines, similarity, query);
		return selectMemoryMatches({
			lines,
			scores,
			alreadyShown: input.alreadyShown,
			today: input.today,
			project: input.project,
			query,
		});
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
		if (matches === "timeout") {
			console.warn("Memory read hook timed out.", {
				ms: Date.now() - started,
				lines: lines.length,
			});
			return result("timeout");
		}
		return result(matches.length ? "matched" : "none", matches);
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
