import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import {
	type MemoryDreamStatus,
	memoryDreamSchedule,
} from "#/domain/memory-dream-schedule";
import {
	MEMORY_EDIT_TEXT_MAX,
	MEMORY_PROJECT_MAX,
	type MemoryEdit,
} from "#/domain/memory-edit";
import type { DreamInput } from "#/domain/memory-lanes";
import {
	type MEMORY_MODES,
	memoryPath,
	memoryToday,
} from "#/domain/memory-repo";
import {
	memoryRepo,
	memoryRepoName,
	memoryReposAvailable,
} from "#/server/adapters/memory-repos";
import {
	forgetMemoryEmbeddings,
	lastMemoryDreamRun,
	lastMemoryReview,
	markMemoryDreamed,
	memoryLastActivity,
	memorySettings,
	saveMemoryMode,
} from "#/server/adapters/memory-settings";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import {
	commitMemoryEdit,
	dreamHistory,
	lastDreamChange,
} from "#/server/services/memory-edit";
import {
	DREAM_IDLE_SECONDS,
	DREAM_REVIEW_DAYS,
} from "#/server/services/memory-jobs";
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
	.validator((data: unknown) =>
		z.object({ path: z.string().max(512) }).parse(data),
	)
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

/** The settings switch: memory off or full. "spec" is set only by evals. */
export const saveMemoryModeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ mode: z.enum(["off", "full"]) }).parse(data),
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
export const clearMemoryFn = createServerFn({ method: "POST" })
	// An empty object, so the call has the JSON body requireSameOrigin needs.
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const { repo } = await userRepo(user.id);
		await repo?.destroy();
		await forgetMemoryEmbeddings(user.id);
		await markMemoryDreamed(user.id, new Date());
	});

/**
 * Undo for "Saved to memory": removes that entry in one commit. A concurrent
 * edit to the same file is re-read once; an entry already gone is not an error.
 */
export const undoMemoryLineFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ path: z.string().max(512), text: z.string().min(1).max(2000) })
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

const lineRef = z.object({
	path: z.string().max(512),
	line: z.number().int().min(1).max(100_000),
	text: z.string().min(1).max(2000),
});
const editText = z
	.string()
	.min(1)
	.max(MEMORY_EDIT_TEXT_MAX * 2);
const projectName = z.string().min(1).max(MEMORY_PROJECT_MAX).nullable();
const memoryEdit = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("add"),
		text: editText,
		project: projectName,
		always: z.boolean(),
		topic: z.string().max(200).nullable().optional(),
	}),
	z.object({
		op: z.literal("update"),
		ref: lineRef,
		text: editText.optional(),
		project: projectName.optional(),
		always: z.boolean().optional(),
	}),
	z.object({ op: z.literal("delete"), ref: lineRef }),
]);

/**
 * A manual edit from the Memory view (add, change text, move between
 * Personal and a project, pin as an always-on rule, delete) as one commit.
 * Invalid input comes back as `error`, for the form to show.
 */
export const editMemoryFn = createServerFn({ method: "POST" })
	.validator((data: unknown): MemoryEdit => memoryEdit.parse(data))
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		if (data.op !== "add" && !memoryPath(data.ref.path))
			throw new Error("Invalid memory path.");
		const { repo } = await userRepo(user.id);
		if (!repo) throw new Error("Memory is unavailable.");
		return commitMemoryEdit(repo, data, memoryToday());
	});

/**
 * Dreaming at a glance: when it last ran, when it runs next, the next
 * weekly review, and what the newest dream commit changed.
 */
export const readMemoryDreamsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<MemoryDreamStatus | null> => {
		const user = await requireUser(getRequest().headers);
		if (!memoryReposAvailable()) return null;
		const { settings, repo } = await userRepo(user.id);
		const [lastRun, lastReview, lastActivity, lastChange] = await Promise.all([
			lastMemoryDreamRun(user.id),
			lastMemoryReview(user.id),
			memoryLastActivity(user.id),
			repo
				? lastDreamChange(repo, memoryToday()).catch(() => null)
				: Promise.resolve(null),
		]);
		return {
			...memoryDreamSchedule({
				now: new Date(),
				off: settings.mode === "off",
				lastActivity,
				dreamedThrough: settings.dreamedThrough,
				lastReview,
				idleMs: DREAM_IDLE_SECONDS * 1000,
				// The maintenance job looks for idle users every 5 minutes.
				tickMs: 5 * 60_000,
				reviewDays: DREAM_REVIEW_DAYS,
			}),
			lastRunAt: lastRun?.toISOString() ?? null,
			lastReviewAt: lastReview?.toISOString() ?? null,
			lastChange,
		};
	},
);

/** Whether memory is on, for the Settings switch, without reading the repo. */
export const readMemoryModeFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		if (!memoryReposAvailable())
			return { available: false, mode: "off" as const };
		const settings = await memorySettings(user.id);
		return { available: true, mode: settings.mode };
	},
);

/** The memory lanes' history: recent dreams and the lines each merged. */
export const readMemoryGraphFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<{ dreams: DreamInput[] }> => {
		const user = await requireUser(getRequest().headers);
		if (!memoryReposAvailable()) return { dreams: [] };
		const { repo } = await userRepo(user.id);
		if (!repo) return { dreams: [] };
		return {
			dreams: await dreamHistory(repo, memoryToday()).catch(() => []),
		};
	},
);
