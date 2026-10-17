import type { ModelMessage } from "ai";
import { isUserRequestMessage } from "#/domain/api-conversation";
import type { MemoryWording } from "#/domain/harness-variant";
import {
	currentMemoryRecall,
	type MemoryRecall,
	recalledMemoryLine,
	savedMemoryLines,
	withSavedMemory,
} from "#/domain/memory-marker";
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
	memoryLines,
	memoryMatchesPart,
	memoryQueryText,
	memoryToday,
	selectMemoryMatches,
	withMemoryParts,
} from "#/domain/memory-repo";
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
} from "../adapters/memory-settings";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/** The VM's Git token outlives any single durable step; each step mints a new one. */
const VM_TOKEN_TTL_SECONDS = 3600;
const READ_HOOK_TIMEOUT_MS = 4000;
/** Bounds embedding work on a turn; larger memories embed over several turns. */
const MAX_EMBEDDED_LINES = 400;
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
	/** The save hook: queued after a completed turn (full mode). */
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
	const wording = options.wording ?? "notes";
	const url = chatSourceUrl(options.appUrl ?? memoryAppUrl(), owner.id);
	const chatTitles =
		options.chatTitles ??
		((ids: readonly string[]) => memoryChatTitles(owner.userId, ids));
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
	return {
		mode,
		instructions: memoryInstructions(
			mode,
			{
				url,
				project: projectName,
			},
			wording,
		),
		async prepareVm(workspace) {
			try {
				const credentials = await repo.credentials(VM_TOKEN_TTL_SECONDS);
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
		async attach(messages, items, workspace) {
			const unchanged = { messages, recall: null };
			const index = currentRequestIndex(messages, items);
			if (index < 0) return unchanged;
			const current = messages[index];
			// A resumed step replays the parts it already attached.
			if (attachedMemory([current]).length) return unchanged;
			const snapshot = await repo.snapshot().catch((error) => {
				console.warn("Memory could not be read.", {
					error: error instanceof Error ? error.name : "unknown",
				});
				return null;
			});
			if (!snapshot) return unchanged;
			const shown = attachedMemory(messages).join("\n");
			const firstRequest =
				items.filter((item) => item.kind === "userMessage").length === 1 &&
				!memoryIndexShown(shown);
			const entry = snapshot.files[MEMORY_ENTRY];
			const showEntry =
				firstRequest &&
				entry !== undefined &&
				entry.trim() !== EMPTY_MEMORY.trim();
			const matches =
				mode === "full" && embed
					? await readHook({
							snapshot,
							embed,
							userId: owner.userId,
							query: latestUserText(items),
							alreadyShown: (raw) =>
								shown.includes(raw) ||
								(showEntry && (entry ?? "").includes(raw)),
							today: today(),
							project: projectName,
						})
					: [];
			const recall: MemoryRecall = {
				head: snapshot.head,
				...(showEntry ? { index: true as const } : {}),
				lines: await recalledLines(matches),
			};
			if (!showEntry && !matches.length) return { messages, recall };
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
				...(matches.length
					? [memoryMatchesPart(matches, missing, wording)]
					: []),
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
			if (mode !== "full") return;
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
 * Supermemory-style recall: embed the message, rank every memory line by
 * cosine similarity, keep the best few above the cutoff. Skipped on timeout.
 */
export async function readHook(input: {
	snapshot: MemorySnapshot;
	embed: Embed;
	userId: string;
	query: string;
	alreadyShown: (raw: string) => boolean;
	today: string;
	project: string | null;
	cache?: Parameters<typeof cachedLineEmbeddings>[3];
	timeoutMs?: number;
}): Promise<MemoryLine[]> {
	const query = memoryQueryText(input.query);
	if (!query) return [];
	const lines = memoryLines(input.snapshot.files)
		.filter((entry) => entry.path !== MEMORY_ENTRY)
		.slice(0, MAX_EMBEDDED_LINES);
	if (!lines.length) return [];
	const work = (async () => {
		const queryVector = await input.embed.query(query);
		const vectors = await cachedLineEmbeddings(
			input.userId,
			lines.map(memoryLineEmbeddingText),
			input.embed,
			input.cache,
		);
		const scores = new Map(
			lines.map((entry, index) => [
				entry,
				cosineSimilarity(queryVector, vectors[index]),
			]),
		);
		return selectMemoryMatches({
			lines,
			scores,
			alreadyShown: input.alreadyShown,
			today: input.today,
			project: input.project,
		});
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<MemoryLine[]>((resolve) => {
				timer = setTimeout(
					() => resolve([]),
					input.timeoutMs ?? READ_HOOK_TIMEOUT_MS,
				);
			}),
		]);
	} catch (error) {
		console.warn("Memory read hook skipped.", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return [];
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
