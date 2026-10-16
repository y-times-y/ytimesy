import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { MEMORY_MODES, memoryPath } from "#/domain/memory-repo";
import {
	memoryRepo,
	memoryRepoName,
	memoryReposAvailable,
} from "#/server/adapters/memory-repos";
import {
	forgetMemoryEmbeddings,
	markMemoryDreamed,
	memorySettings,
	saveMemoryMode,
} from "#/server/adapters/memory-settings";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { removeMemoryLine } from "#/server/services/memory-undo";

export type MemoryOverview = {
	available: boolean;
	mode: (typeof MEMORY_MODES)[number];
	files: { path: string; content: string }[];
};

async function userRepo(userId: string) {
	const settings = await memorySettings(userId);
	return {
		settings,
		repo: memoryRepo(memoryRepoName(userId, settings.repo)),
	};
}

/** The signed-in user's memory repo at its latest commit. */
export const readMemoryFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<MemoryOverview> => {
		const user = await requireUser(getRequest().headers);
		if (!memoryReposAvailable())
			return { available: false, mode: "off", files: [] };
		const { settings, repo } = await userRepo(user.id);
		const snapshot = repo ? await repo.snapshot() : { files: {} };
		return {
			available: true,
			mode: settings.mode,
			files: Object.entries(snapshot.files)
				.map(([path, content]) => ({ path, content }))
				.sort((a, b) => a.path.localeCompare(b.path)),
		};
	},
);

/** Commits that changed one file, newest first, each with its diff. */
export const readMemoryHistoryFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => z.object({ path: z.string() }).parse(data))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const path = memoryPath(data.path);
		if (!path) throw new Error("Invalid memory path.");
		const { repo } = await userRepo(user.id);
		if (!repo) return [];
		return (await repo.history(path, 20)).map((commit) => ({
			hash: commit.hash,
			message: commit.message,
			committedAt: commit.committedAt,
			patch: createTwoFilesPatch(
				path,
				path,
				commit.before ?? "",
				commit.after ?? "",
				"",
				"",
				{ context: 2 },
			)
				.split("\n")
				.slice(4)
				.join("\n"),
		}));
	});

export const saveMemoryModeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ mode: z.enum(MEMORY_MODES) }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		await saveMemoryMode(user.id, data.mode);
	});

/**
 * Deletes the memory repo and its cached embeddings. Earlier chats are not
 * dreamed back into the new, empty memory.
 */
export const clearMemoryFn = createServerFn({ method: "POST" }).handler(
	async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const { repo } = await userRepo(user.id);
		await repo?.destroy();
		await forgetMemoryEmbeddings(user.id);
		await markMemoryDreamed(user.id, new Date());
	},
);

/**
 * Undo for "Saved to memory": removes that entry in one commit. A concurrent
 * edit to the same file is re-read once; an entry already gone is not an error.
 */
export const undoMemoryLineFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ path: z.string(), text: z.string().min(1).max(2000) })
			.parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const path = memoryPath(data.path);
		if (!path) throw new Error("Invalid memory path.");
		const { repo } = await userRepo(user.id);
		if (!repo) throw new Error("Memory is unavailable.");
		return removeMemoryLine(repo, { path, text: data.text });
	});
