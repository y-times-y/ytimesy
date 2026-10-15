import type { ModelMessage } from "ai";
import { isUserRequestMessage } from "#/domain/api-conversation";
import {
	annotateMemoryText,
	attachedMemory,
	chatSourceUrl,
	cosineSimilarity,
	EMPTY_MEMORY,
	entryPaths,
	MEMORY_ENTRY,
	MEMORY_MESSAGE_HEADER,
	type MemoryLine,
	type MemoryMode,
	memoryCloneScript,
	memoryEntryPart,
	memoryInstructions,
	memoryLineEmbeddingText,
	memoryLines,
	memoryMatchesPart,
	memoryQueryText,
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
import { memoryProjectName, memorySettings } from "../adapters/memory-settings";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/** The VM's Git token outlives any single durable step; each step mints a new one. */
const VM_TOKEN_TTL_SECONDS = 3600;
const READ_HOOK_TIMEOUT_MS = 4000;
/** Bounds embedding work on a turn; larger memories embed over several turns. */
const MAX_EMBEDDED_LINES = 400;

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
	/** MEMORY.md at chat start and the read hook, attached to the current request. */
	attach(
		messages: ModelMessage[],
		items: readonly SessionItem[],
		workspace: () => Promise<AgentToolWorkspace>,
	): Promise<ModelMessage[]>;
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
		/** Evaluations switch hooks per arm; production uses the user's mode. */
		mode?: MemoryMode;
		repo?: MemoryRepo | null;
		embed?: Embed | null;
		today?: () => string;
		projectName?: string | null;
	} = {},
): Promise<TurnMemory | null> {
	const settings = await memorySettings(owner.userId).catch((error) => {
		console.warn("Memory settings are unavailable; memory is off.", {
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	});
	const mode = options.mode ?? settings?.mode ?? "off";
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
	const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
	const url = chatSourceUrl(
		options.appUrl ?? process.env.APP_URL ?? "http://localhost:3000",
		owner.id,
	);
	return {
		mode,
		instructions: memoryInstructions(mode, {
			url,
			project: projectName,
		}),
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
			const index = currentRequestIndex(messages, items);
			if (index < 0) return messages;
			const current = messages[index];
			// A resumed step replays the parts it already attached.
			if (attachedMemory([current]).length) return messages;
			const snapshot = await repo.snapshot().catch((error) => {
				console.warn("Memory could not be read.", {
					error: error instanceof Error ? error.name : "unknown",
				});
				return null;
			});
			if (!snapshot) return messages;
			const shown = attachedMemory(messages).join("\n");
			const firstRequest =
				items.filter((item) => item.kind === "userMessage").length === 1 &&
				!shown.includes(MEMORY_MESSAGE_HEADER);
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
			if (!showEntry && !matches.length) return messages;
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
							),
						]
					: []),
				...(matches.length ? [memoryMatchesPart(matches, missing)] : []),
			];
			const next = [...messages];
			next[index] = withMemoryParts(
				current as { role: "user"; content: string },
				parts,
			) as ModelMessage;
			return next;
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
		const [queryVector] = await input.embed([query]);
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
