import { createHash } from "node:crypto";
import { detectMediaType } from "@ai-sdk/provider-utils";
import { type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentProviderId } from "#/domain/agent-provider";
import {
	CANVAS_HTML_LIMIT,
	type CanvasToolResult,
	canvasConfirmation,
	canvasTitle,
	SHOW_CANVAS_TOOL,
} from "#/domain/canvas";
import {
	canvasHasImages,
	canvasOutline,
	canvasOutlinePage,
	canvasSizeKb,
	canvasSourcePage,
} from "#/domain/canvas-text";
import {
	attachmentSizeLabel,
	isViewableImage,
	type MessageAttachment,
} from "#/domain/message-attachment";
import { harnessForModelId } from "#/domain/model-harness";
import { wakeMessageId } from "#/domain/pull-request-wake";
import type { SessionItem } from "#/domain/session-item";
import { threadOutcomeLines } from "#/domain/thread-outcome";
import {
	archiveThreadInput,
	messageThreadInput,
	readCanvasInput,
	retryThreadInput,
	showCanvasInput,
	startThreadInput,
	stopThreadInput,
	threadsOverview,
	threadTimesText,
	Y_SQUARED_ARCHIVE_THREAD_DESCRIPTION,
	Y_SQUARED_ARCHIVE_THREAD_TOOL,
	Y_SQUARED_MAX_STARTS_PER_TURN,
	Y_SQUARED_MESSAGE_THREAD_DESCRIPTION,
	Y_SQUARED_MESSAGE_THREAD_TOOL,
	Y_SQUARED_READ_CANVAS_DESCRIPTION,
	Y_SQUARED_READ_CANVAS_TOOL,
	Y_SQUARED_RETRY_THREAD_DESCRIPTION,
	Y_SQUARED_RETRY_THREAD_TOOL,
	Y_SQUARED_SHOW_CANVAS_DESCRIPTION,
	Y_SQUARED_START_THREAD_DESCRIPTION,
	Y_SQUARED_START_THREAD_TOOL,
	Y_SQUARED_STOP_THREAD_DESCRIPTION,
	Y_SQUARED_STOP_THREAD_TOOL,
	Y_SQUARED_THREAD_DESCRIPTION,
	Y_SQUARED_THREAD_LIMIT,
	Y_SQUARED_THREAD_TOOL,
	Y_SQUARED_THREADS_TOOL,
} from "#/domain/y-squared";
import {
	type CrewRow,
	type CrewState,
	crewDigest,
	crewTitle,
} from "#/domain/y-squared-crew";
import {
	findAttachment,
	viewImageInput,
	Y_SQUARED_IMAGE_BYTES,
	Y_SQUARED_IMAGE_MARK,
	Y_SQUARED_VIEW_IMAGE_DESCRIPTION,
	Y_SQUARED_VIEW_IMAGE_TOOL,
} from "#/domain/y-squared-images";
import {
	canonicalReasoning,
	checkThreadModelSettings,
	listModelsInput,
	modelListText,
	resolveThreadModel,
	setThreadModelInput,
	THREAD_MODEL_LINE,
	type ThreadModel,
	type ThreadModelChoices,
	Y_SQUARED_LIST_MODELS_DESCRIPTION,
	Y_SQUARED_LIST_MODELS_TOOL,
	Y_SQUARED_MODEL_CHOICE_OFF,
	Y_SQUARED_SET_THREAD_MODEL_DESCRIPTION,
	Y_SQUARED_SET_THREAD_MODEL_TOOL,
} from "#/domain/y-squared-models";
import {
	describeSpec,
	formatLocal,
	scheduleInput,
	scheduleLines,
	Y_SQUARED_SCHEDULE_DESCRIPTION,
	Y_SQUARED_SCHEDULE_TOOL,
} from "#/domain/y-squared-proactive";
import {
	agentSessionMetadataForOwner,
	listSidebarAgentSessions,
} from "../adapters/agent-sessions";
import {
	CANVAS_FEEDBACK_LIMIT,
	latestCanvasForOwner,
} from "../adapters/canvas-read";
import { downloadMessageAttachment } from "../adapters/checkpoints/storage";
import type { ThreadModelChange } from "../adapters/thread-model";
import { threadOutcomeForOwner } from "../adapters/thread-outcome";
import {
	type YSquaredCrewClient,
	ySquaredCrewFor,
} from "../adapters/y-squared-crew-client";
import {
	sendComposerMessage,
	stopTurnKeepingQueue,
} from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

export type YSquaredToolDeps = Deps;
type Deps = {
	readonly list: typeof listSidebarAgentSessions;
	/** The project's crew (one Durable Object request); null where there is none (local development). */
	readonly crew: (projectId: string) => YSquaredCrewClient | null;
	readonly now: () => number;
	/** One chat's row without its transcript (metadata only). */
	readonly metadata: typeof agentSessionMetadataForOwner;
	/** What a thread's final turn produced (its reply, questions, plan, canvases): two small reads, only when Y² asks. */
	readonly outcome: typeof threadOutcomeForOwner;
	/** One canvas of a thread, latest revision, read whole (one item by id): only when Y² reads or shows it. */
	readonly canvas: typeof latestCanvasForOwner;
	/** One attachment's base64 bytes (checks the owner). */
	readonly download: typeof downloadMessageAttachment;
	/** The person's own send path: queues behind a running turn, else starts a turn (admission applies). */
	readonly send: (
		machines: WorkspaceMachines,
		...args: Parameters<typeof sendComposerMessage> extends [
			unknown,
			...infer Rest,
		]
			? Rest
			: never
	) => Promise<{
		readonly turnStatus: string;
		readonly failed?: string;
		/** The chat the message went to (a new thread's id); absent from an older edge. */
		readonly sessionId?: string | null;
	}>;
	/** Whether a pull request is still open: true open, false merged or closed, null unknown. */
	readonly prOpen: (
		userId: string,
		projectId: string,
		url: string,
	) => Promise<boolean | null>;
	/** Archives a root chat (stops its turn, keeps everything; Settings > Archived restores it). */
	readonly archive: (userId: string, sessionId: string) => Promise<void>;
	/** The models this person can run now, and whether Y² may choose (one read per call). */
	readonly models: (
		userId: string,
		projectId: string,
	) => Promise<ThreadModelChoices>;
	/** Points a thread at another model from its next turn (one statement). */
	readonly setModel: (change: ThreadModelChange) => Promise<{
		readonly found: boolean;
		readonly lineWritten: boolean;
		readonly running?: boolean;
	}>;
	/** The Stop button's path. */
	readonly stop: (
		machines: WorkspaceMachines,
		...args: Parameters<typeof stopTurnKeepingQueue> extends [
			unknown,
			...infer Rest,
		]
			? Rest
			: never
	) => Promise<{ readonly turnStatus: string }>;
};

// Bound at call time, so a module that imports this file never reads them early.
const defaultDeps: Deps = {
	list: (...args) => listSidebarAgentSessions(...args),
	crew: (projectId) => ySquaredCrewFor(projectId),
	now: () => Date.now(),
	download: (...args) => downloadMessageAttachment(...args),
	metadata: (...args) => agentSessionMetadataForOwner(...args),
	outcome: (...args) => threadOutcomeForOwner(...args),
	canvas: (...args) => latestCanvasForOwner(...args),
	send: async (machines, scope, input) => {
		const view = await Effect.runPromise(
			sendComposerMessage(machines, scope, input),
		);
		return {
			turnStatus: view.turnStatus,
			sessionId: view.agentSessionId,
			...(view.connection.status === "failed"
				? { failed: view.connection.message }
				: {}),
		};
	},
	prOpen: async (userId, projectId, url) => {
		const { pullRequestIsOpen } = await import("./y-squared-pr-state");
		return pullRequestIsOpen({ userId, projectId, url });
	},
	models: async (userId, projectId) =>
		(await import("./y-squared-models")).ySquaredThreadModels(
			userId,
			projectId,
		),
	setModel: async (change) =>
		(await import("../adapters/thread-model")).setThreadModel(change),
	archive: async (userId, sessionId) => {
		// Lazy: the archive service pulls in the machine and project services.
		const { archiveOwned } = await import("./archive");
		await archiveOwned(userId, "chat", sessionId);
	},
	stop: async (machines, scope) => {
		const view = await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
		return { turnStatus: view.turnStatus };
	},
};

/** The product's deps, for the edge's side of the `ySquared` port. */
export const ySquaredToolDefaultDeps = defaultDeps;

type Sidebar = Awaited<ReturnType<typeof listSidebarAgentSessions>>[number];

/**
 * A thread the crew has not noted yet (started a moment ago, or queued behind
 * the budget): its own metadata row, so Y² can open it by the id
 * `start_thread` gave. Before, `thread` said "No such thread" until the
 * thread's first note reached the crew.
 */
function rowFromMetadata(chat: {
	readonly id: string;
	readonly title: string;
	readonly turnStatus: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}): CrewRow {
	const updatedAt = Date.parse(chat.updatedAt) || 0;
	const state: CrewState =
		chat.turnStatus === "running"
			? "working"
			: chat.turnStatus === "failed"
				? "failed"
				: "finished";
	return {
		sessionId: chat.id,
		title: crewTitle(chat.title),
		state,
		waitingOn: null,
		prUrl: null,
		lastReply: null,
		lastRequest: null,
		updatedAt,
		createdAt: Date.parse(chat.createdAt) || 0,
		lastActiveAt: updatedAt,
		workingSince: state === "working" ? updatedAt : null,
	};
}

/** A sidebar row as a crew row: metadata only, no transcript. */
function rowFromSidebar(chat: Sidebar): CrewRow {
	const state: CrewState = chat.waitingOn
		? chat.waitingOn === "failed"
			? "failed"
			: "waiting"
		: chat.workingSince
			? "working"
			: "finished";
	return {
		sessionId: chat.id,
		title: chat.title,
		state,
		waitingOn: chat.waitingOn ?? null,
		prUrl: null,
		lastReply: null,
		lastRequest: null,
		updatedAt: Date.parse(chat.workingSince ?? chat.updatedAt ?? "") || 0,
		createdAt: 0,
		lastActiveAt: 0,
		workingSince:
			state === "working"
				? Date.parse(chat.workingSince ?? chat.updatedAt ?? "") || null
				: null,
	};
}

/**
 * Y²'s read tools (src/domain/y-squared.ts): every thread of its project,
 * and one thread's details. They read the project's crew (one Durable
 * Object request, no transcript): rows each thread's chat object pushed when
 * its turn started and settled. Y² has no machine.
 */
export function ySquaredTools(input: {
	readonly userId: string;
	readonly projectId: string;
	/** Y² itself, left out of what it reports. */
	readonly selfId: string;
	/** The turn's workspace machines: only passed on to the send and stop paths (Y² itself never gets a VM). */
	readonly machines?: WorkspaceMachines;
	/** Y²'s own route, which the threads it starts and wakes inherit. */
	readonly modelId?: string | null;
	readonly harnessId?: AgentProviderId;
	/** The turn's id: keys the sends so a replayed step does not send twice. */
	readonly turnId?: string;
	/** Y²'s own items now (this turn's), to see which canvas revisions it already shows. */
	readonly items?: () => readonly SessionItem[];
	readonly deps?: Partial<Deps>;
}): ToolSet {
	const deps = { ...defaultDeps, ...input.deps };
	let starts = 0;
	/** A root thread of this project that is not Y²: metadata only, no transcript. */
	const ownThread = async (id: string) => {
		if (id === input.selfId) return null;
		const chat = await deps.metadata(input.userId, id);
		if (
			!chat ||
			chat.projectId !== input.projectId ||
			chat.id === input.selfId ||
			chat.parentSessionId ||
			chat.agentRole
		)
			return null;
		return chat;
	};
	const sendKey = (kind: string, ...parts: string[]) =>
		wakeMessageId(
			`y2-${kind}:${input.turnId ?? "no-turn"}:${createHash("sha256")
				.update(parts.join("\u0000"))
				.digest("hex")}`,
		);
	/** Tells the crew Y² is about to send (before it does), so that thread's start is not taken for the person's. */
	const markSent = async (sessionId: string | null) => {
		await deps
			.crew(input.projectId)
			?.noteY2Sent?.(sessionId)
			.catch(() => undefined);
	};
	/** The user-message attachments of THIS chat only. */
	const ownAttachments = (): MessageAttachment[] =>
		(input.items?.() ?? []).flatMap((item) =>
			item.kind === "userMessage" ? (item.attachments ?? []) : [],
		);
	const unknownAttachment = (ref: string) =>
		`No attachment "${ref}" in this chat. Attachments: ${
			ownAttachments()
				.map((a) => a.name)
				.join(", ") || "none"
		}.`;
	/** Files of this chat to pass on with a message (the target chat stores its own copy). */
	const forwarded = async (refs: readonly string[] | undefined) => {
		if (!refs?.length) return { files: undefined };
		const own = ownAttachments();
		const found = new Map<string, MessageAttachment>();
		for (const ref of refs) {
			const attachment = findAttachment(own, ref);
			if (!attachment) return { error: unknownAttachment(ref) };
			found.set(attachment.id, attachment);
		}
		const files = await Promise.all(
			[...found.values()].map(async (a) => ({
				name: a.name,
				mediaType: a.mediaType,
				base64: await deps.download(input.userId, input.selfId, a.id),
			})),
		);
		return { files };
	};
	/** A thread's own route: its recorded model decides its harness (a change of model may cross runtimes). */
	const routeOf = (chat: {
		listedModelId: string | null;
		harness: AgentProviderId;
	}) => ({
		modelId: chat.listedModelId ?? input.modelId ?? "",
		harnessId:
			(chat.listedModelId && harnessForModelId(chat.listedModelId)) ||
			chat.harness,
	});
	/** The send settings a chosen model and its optional reasoning / speed make. */
	const modelSettings = (
		model: ThreadModel,
		settings: { reasoning?: string; speed?: string },
	) => ({
		modelId: model.id,
		...(settings.reasoning
			? { variant: canonicalReasoning(model, settings.reasoning) }
			: {}),
		...(settings.speed
			? model.harness === "codex"
				? { fast: true }
				: { speed: settings.speed.trim().toLowerCase() as "fast" | "ultrafast" }
			: {}),
	});
	/** A requested model checked against what the person can run now; an error says what is valid. */
	const pickModel = async (
		request: string,
		settings: { reasoning?: string; speed?: string },
	): Promise<{ model: ThreadModel } | { error: string }> => {
		const choices = await deps.models(input.userId, input.projectId);
		if (!choices.enabled) return { error: Y_SQUARED_MODEL_CHOICE_OFF };
		const picked = resolveThreadModel(request, choices.models);
		if (!picked.ok) return { error: picked.error };
		const invalid = checkThreadModelSettings(picked.model, settings);
		return invalid ? { error: invalid } : { model: picked.model };
	};
	const noThread = "No such thread in this project.";
	const noMachines = "Threads cannot be run here.";
	const noCanvas = (thread: string, title: string) =>
		`"${thread}" has no canvas titled "${title}" (or its document is no longer stored). Call \`thread\` to see its canvases.`;
	const staleNote = (found: { revision: number; latestRevision: number }) =>
		found.latestRevision > found.revision
			? `(The thread's newest revision ${found.latestRevision} no longer has its document stored; this is revision ${found.revision}, the latest that does.)`
			: "";
	/** The project's root, unarchived chats: one metadata read. */
	const sidebar = () => deps.list(input.userId, input.projectId);
	/** Metadata of the project's threads: the cold start and where no crew exists. */
	const fromSidebar = (chats: Sidebar[]) =>
		chats
			.filter((chat) => chat.id !== input.selfId && !chat.unused)
			.slice(0, Y_SQUARED_THREAD_LIMIT)
			.map(rowFromSidebar);
	/** The crew's rows; an empty, never-filled crew is filled once from the sidebar. */
	const crewRows = async (): Promise<CrewRow[]> => {
		const crew = deps.crew(input.projectId);
		if (!crew) return fromSidebar(await sidebar());
		// Both at once: on a box each is a hop through the edge.
		const [chats, listed] = await Promise.all([sidebar(), crew.list()]);
		// Only the project's own threads: the crew also holds rows of helper
		// chats (builders) and of threads since archived, which the list of
		// root, unarchived chats leaves out.
		const roots = new Set(chats.map((chat) => chat.id));
		const rows = listed.rows.filter(
			(row) => row.sessionId !== input.selfId && roots.has(row.sessionId),
		);
		if (rows.length || listed.reconciled) return rows;
		const seeded = fromSidebar(chats);
		await crew.reconcile(seeded).catch(() => undefined);
		return seeded;
	};

	return {
		[Y_SQUARED_THREADS_TOOL]: tool({
			description:
				"Every thread in this project: what it needs from the person, whether it is working, when it was last active and created, its last request, last reply and pull request. Threads that need the person come first, then the most recently active.",
			inputSchema: z.object({}),
			execute: async () => {
				const now = deps.now();
				return threadsOverview(
					(await crewRows()).map((row) => crewDigest(row, now)),
					now,
				);
			},
		}),
		[Y_SQUARED_THREAD_TOOL]: tool({
			description: Y_SQUARED_THREAD_DESCRIPTION,
			inputSchema: z.object({
				id: z.string().min(1).max(64).describe("The thread's id"),
			}),
			execute: async ({ id }) => {
				const crew = deps.crew(input.projectId);
				const noted = crew
					? await crew.thread(id)
					: fromSidebar(await sidebar()).find(
							(entry) => entry.sessionId === id,
						);
				// Not noted yet (just started, queued): the thread's own row.
				const unnoted = noted ? null : await ownThread(id).catch(() => null);
				const row = noted ?? (unnoted ? rowFromMetadata(unnoted) : null);
				if (!row || row.sessionId === input.selfId)
					return "No such thread in this project.";
				const now = deps.now();
				const digest = crewDigest(row, now);
				// The thread's own words: the full final reply (long ones start and
				// end), its questions, plan and canvases. Best effort: the crew's short
				// last reply stands in when the read fails.
				const outcome = await deps.outcome(input.userId, id).catch(() => null);
				const substance = outcome
					? threadOutcomeLines(outcome)
					: [
							digest.lastReply
								? `Last reply: ${digest.lastReply}`
								: "No reply yet.",
						];
				return [
					`"${digest.title}" (id ${digest.id})`,
					digest.waitingOn
						? `Status: it ${digest.waitingOn}`
						: digest.workingForMinutes !== null
							? `Status: working for ${digest.workingForMinutes} min`
							: "Status: idle",
					threadTimesText(digest, now),
					digest.lastRequest ? `Last request: ${digest.lastRequest}` : "",
					digest.pullRequest ? `Pull request: ${digest.pullRequest}` : "",
					...substance,
				]
					.filter(Boolean)
					.join("\n");
			},
		}),
		[Y_SQUARED_READ_CANVAS_TOOL]: tool({
			description: Y_SQUARED_READ_CANVAS_DESCRIPTION,
			inputSchema: readCanvasInput,
			execute: async ({ id, title, part, offset, limit }) => {
				const chat = await ownThread(id);
				if (!chat) return noThread;
				const name = canvasTitle(title);
				const found = await deps.canvas(input.userId, chat.id, name);
				if (!found) return noCanvas(chat.title, name);
				// Never more than a canvas may hold; only bounded text leaves this
				// function: a page of the outline, or a window of the source.
				const html = found.html.slice(0, CANVAS_HTML_LIMIT);
				const about = `Canvas "${found.title}" of "${chat.title}": revision ${found.revision}, ${canvasSizeKb(found.html.length)} KB${canvasHasImages(html) ? ", has images" : ""}${found.path ? `, file ${found.path}` : ""}`;
				if (offset !== undefined || limit !== undefined) {
					const source = canvasSourcePage(html, offset ?? 0, limit);
					return [
						`${about}; HTML source characters ${source.offset}–${source.end} of ${source.total}.`,
						staleNote(found),
						source.text || "(nothing at this offset)",
						source.end < source.total
							? `[More: call ${Y_SQUARED_READ_CANVAS_TOOL} with offset ${source.end}.]`
							: "",
					]
						.filter(Boolean)
						.join("\n");
				}
				const page = canvasOutlinePage(canvasOutline(html), part ?? 1);
				return [
					`${about}; part ${page.part} of ${page.parts}.`,
					staleNote(found),
					found.feedback && page.part === 1
						? `The person's newest feedback on it:\n${found.feedback.slice(0, CANVAS_FEEDBACK_LIMIT)}\n---`
						: "",
					page.text || "(no visible text)",
					page.part < page.parts
						? `[More: call ${Y_SQUARED_READ_CANVAS_TOOL} with part ${page.part + 1}.]`
						: "",
				]
					.filter(Boolean)
					.join("\n");
			},
		}),
		[SHOW_CANVAS_TOOL]: tool({
			description: Y_SQUARED_SHOW_CANVAS_DESCRIPTION,
			inputSchema: showCanvasInput,
			execute: async ({ id, title }): Promise<CanvasToolResult | string> => {
				const chat = await ownThread(id);
				if (!chat) return noThread;
				const name = canvasTitle(title);
				const found = await deps.canvas(input.userId, chat.id, name);
				if (!found) return noCanvas(chat.title, name);
				if (found.html.length > CANVAS_HTML_LIMIT)
					return `Not shown: "${found.title}" has ${found.html.length.toLocaleString("en-US")} characters; a canvas holds at most ${CANVAS_HTML_LIMIT.toLocaleString("en-US")}. Ask the thread to make it smaller.`;
				const shownHere = (input.items?.() ?? []).some(
					(item) =>
						item.kind === "canvas" &&
						item.title === found.title &&
						item.revision === found.revision &&
						item.ownerThreadId === chat.id,
				);
				if (shownHere)
					return `Revision ${found.revision} of "${found.title}" is already shown in this chat.${staleNote(found) ? ` ${staleNote(found)}` : ""}`;
				// The chat's item is made from this result (applyApiProgress); the
				// model reads only the confirmation (toModelOutput).
				return {
					shown: true,
					title: found.title,
					revision: found.revision,
					html: found.html,
					...(found.path ? { path: found.path } : {}),
					ownerThreadId: chat.id,
					ownerItemId: found.itemId,
				};
			},
			toModelOutput: ({ output }) => {
				if (typeof output === "string") return { type: "text", value: output };
				const shown = output as CanvasToolResult;
				return {
					type: "text",
					value: `${canvasConfirmation(shown)} It is thread ${shown.ownerThreadId}'s canvas: the person can preview it and pin notes here; feedback on it goes back to that thread.`,
				};
			},
		}),
		[Y_SQUARED_VIEW_IMAGE_TOOL]: tool({
			description: Y_SQUARED_VIEW_IMAGE_DESCRIPTION,
			inputSchema: viewImageInput,
			execute: async ({ attachment: reference }) => {
				const attachment = findAttachment(ownAttachments(), reference);
				if (!attachment) return unknownAttachment(reference);
				if (!isViewableImage(attachment.mediaType))
					return `${attachment.name} is not a PNG, JPEG, GIF or WebP image, so it cannot be viewed.`;
				if (attachment.size > Y_SQUARED_IMAGE_BYTES)
					return `${attachment.name} is ${attachmentSizeLabel(attachment.size)}; images over 3 MB cannot be viewed (there is no way to shrink them here). Ask the person for a smaller one.`;
				const base64 = await deps.download(
					input.userId,
					input.selfId,
					attachment.id,
				);
				const mediaType = detectMediaType({
					data: base64,
					topLevelType: "image",
				});
				if (!mediaType || !isViewableImage(mediaType))
					return `${attachment.name} does not hold a PNG, JPEG, GIF or WebP image.`;
				return {
					name: attachment.name,
					size: attachment.size,
					mediaType,
					base64,
				};
			},
			toModelOutput: ({ output }) =>
				typeof output === "string"
					? { type: "text", value: output }
					: {
							type: "content",
							value: [
								{
									type: "text",
									text: `${Y_SQUARED_IMAGE_MARK}${output.name} (${attachmentSizeLabel(output.size)})`,
								},
								{
									type: "file",
									data: { type: "data", data: output.base64 },
									mediaType: output.mediaType,
								},
							],
						},
		}),
		[Y_SQUARED_START_THREAD_TOOL]: tool({
			description: Y_SQUARED_START_THREAD_DESCRIPTION,
			inputSchema: startThreadInput,
			execute: async ({
				title,
				brief,
				attachments,
				model: requested,
				reasoning,
				speed,
			}) => {
				if (!input.machines || !input.modelId || !input.harnessId)
					return noMachines;
				if (requested === undefined && (reasoning || speed))
					return "Not started: reasoning and speed belong to a model: pass model too (see list_models).";
				// Checked before anything starts: a bad model never starts a thread
				// on a different one.
				const chosen =
					requested === undefined
						? null
						: await pickModel(requested, { reasoning, speed });
				if (chosen && "error" in chosen) return `Not started: ${chosen.error}`;
				const forward = await forwarded(attachments);
				if (forward.error) return `Not started: ${forward.error}`;
				if (starts >= Y_SQUARED_MAX_STARTS_PER_TURN)
					return `Not started: at most ${Y_SQUARED_MAX_STARTS_PER_TURN} threads may be started in one turn. Tell the person what is left to start.`;
				starts++;
				await markSent(null);
				const sent = await deps.send(
					input.machines,
					{
						userId: input.userId,
						projectId: input.projectId,
						harnessId: chosen ? chosen.model.harness : input.harnessId,
						createNew: true,
					},
					{
						// The first line names the chat (sessionTitleFromText).
						text: `${title}\n\n${brief}`,
						...(chosen
							? modelSettings(chosen.model, { reasoning, speed })
							: { modelId: input.modelId }),
						idempotencyKey: sendKey(
							chosen ? "start-model" : "start",
							...(chosen
								? [
										JSON.stringify([
											chosen.model.id,
											canonicalReasoning(chosen.model, reasoning ?? "") ?? null,
											speed?.trim().toLowerCase() ?? null,
										]),
									]
								: []),
							title,
							brief,
							...(attachments ?? []),
						),
						...(forward.files ? { attachments: forward.files } : {}),
					},
				);
				if (sent.failed) return `Not started: ${sent.failed}`;
				// Its id, so Y² can open, message or link the thread at once.
				const named = `"${crewTitle(title) || title}"${sent.sessionId ? ` (id ${sent.sessionId})` : ""}`;
				const on = chosen
					? ` on ${chosen.model.label} (${chosen.model.route})`
					: "";
				return sent.turnStatus === "running"
					? `Started ${named}${on}. You wake when it finishes or needs the person.`
					: `Queued ${named}${on} behind the budget/concurrency limit; it starts by itself when there is room. You wake when it finishes or needs the person.`;
			},
		}),
		[Y_SQUARED_MESSAGE_THREAD_TOOL]: tool({
			description: Y_SQUARED_MESSAGE_THREAD_DESCRIPTION,
			inputSchema: messageThreadInput,
			execute: async ({ id, text, mode = "queue", attachments }) => {
				if (!input.machines || !input.modelId) return noMachines;
				const chat = await ownThread(id);
				if (!chat) return noThread;
				const forward = await forwarded(attachments);
				if (forward.error) return `Not sent: ${forward.error}`;
				await markSent(chat.id);
				const route = routeOf(chat);
				const interrupted =
					mode === "interrupt" && chat.turnStatus === "running";
				const steered = mode === "steer" && chat.turnStatus === "running";
				if (interrupted)
					await deps.stop(input.machines, {
						userId: input.userId,
						projectId: input.projectId,
						sessionId: chat.id,
						harnessId: chat.harness,
						createNew: false,
					});
				const sent = await deps.send(
					input.machines,
					{
						userId: input.userId,
						projectId: input.projectId,
						sessionId: chat.id,
						harnessId: route.harnessId,
						createNew: false,
					},
					{
						text,
						modelId: route.modelId,
						idempotencyKey: sendKey(
							"message",
							chat.id,
							text,
							...(attachments ?? []),
						),
						...(forward.files ? { attachments: forward.files } : {}),
						// Steer: the row waits already released, so the running turn takes
						// it at its next step (releaseQueuedComposerMessage's mark). An idle
						// thread starts a turn as for any send; if the turn ends before the
						// row is stored the send starts the next turn.
						...(steered ? { released: true } : {}),
					},
				);
				if (sent.failed) return `Not sent: ${sent.failed}`;
				if (interrupted)
					return `Stopped the running turn of "${chat.title}" and sent the message; ${
						sent.turnStatus === "running"
							? "its new turn started."
							: "it is queued and starts by itself."
					}`;
				if (steered)
					return `Steering "${chat.title}": the message goes in at its next step (a Claude Code thread takes it after its next tool call, a runner box up to 10 s late); if its turn ends first it starts its next turn with it.`;
				return chat.turnStatus === "running"
					? `Queued the message in "${chat.title}"; it goes in when its current turn ends.`
					: sent.turnStatus === "running"
						? `Sent to "${chat.title}": its turn started.`
						: `Queued the message for "${chat.title}" behind the budget/concurrency limit; it starts by itself when there is room.`;
			},
		}),
		[Y_SQUARED_LIST_MODELS_TOOL]: tool({
			description: Y_SQUARED_LIST_MODELS_DESCRIPTION,
			inputSchema: listModelsInput,
			execute: async () =>
				modelListText(await deps.models(input.userId, input.projectId)),
		}),
		[Y_SQUARED_SET_THREAD_MODEL_TOOL]: tool({
			description: Y_SQUARED_SET_THREAD_MODEL_DESCRIPTION,
			inputSchema: setThreadModelInput,
			execute: async ({
				id,
				model: requested,
				reasoning,
				speed,
				interrupt,
			}) => {
				if (!input.machines) return noMachines;
				if (id === input.selfId)
					return "That is the Super agent itself (you): its model is the person's choice in the composer, not yours.";
				const chat = await ownThread(id);
				if (!chat) return noThread;
				const chosen = await pickModel(requested, { reasoning, speed });
				if ("error" in chosen) return `Not changed: ${chosen.error}`;
				const { model } = chosen;
				const working = `Not changed: "${chat.title}" is working, and its running turn finishes on its current model. Wait for it to finish (you wake when it does) and call ${Y_SQUARED_SET_THREAD_MODEL_TOOL} again, or pass interrupt true to stop the running turn first (what it did stays in the thread).`;
				if (chat.turnStatus === "running" && !interrupt) return working;
				let interrupted = chat.turnStatus === "running";
				const machines = input.machines;
				const stop = async () => {
					const current = await ownThread(chat.id);
					if (!current) return false;
					await deps.stop(machines, {
						userId: input.userId,
						projectId: input.projectId,
						sessionId: chat.id,
						harnessId: current.harness,
						createNew: false,
					});
					return true;
				};
				if (interrupted && !(await stop())) return noThread;
				const settings = modelSettings(model, { reasoning, speed });
				const change = {
					userId: input.userId,
					projectId: input.projectId,
					sessionId: chat.id,
					modelId: model.id,
					harness: model.harness,
					requireIdle: !interrupted,
					...(settings.variant ? { variant: settings.variant } : {}),
					...("speed" in settings && settings.speed
						? { speed: settings.speed }
						: "fast" in settings
							? { speed: "fast" as const }
							: {}),
					line: THREAD_MODEL_LINE(model.label),
					changeId: sendKey(
						"model",
						chat.id,
						model.id,
						reasoning ?? "",
						speed ?? "",
					),
				};
				let changed = await deps.setModel(change);
				if (changed.running && interrupt) {
					if (!(await stop())) return noThread;
					interrupted = true;
					changed = await deps.setModel({ ...change, requireIdle: false });
				}
				if (!changed.found) return noThread;
				if (changed.running) return working;
				const on = `${model.label} (${model.route})${reasoning ? `, reasoning ${reasoning}` : ""}${speed ? `, ${speed} speed` : ""}`;
				return [
					`"${chat.title}" will use ${on} from its next turn; its conversation and checkpoint stay.`,
					interrupted ? "Its running turn was stopped first." : "",
					changed.lineWritten
						? "A quiet line in the thread says so."
						: "A turn had already started again, so the thread's own line was left out; that turn finishes on its previous model.",
				]
					.filter(Boolean)
					.join(" ");
			},
		}),
		[Y_SQUARED_SCHEDULE_TOOL]: tool({
			description: Y_SQUARED_SCHEDULE_DESCRIPTION,
			inputSchema: scheduleInput,
			execute: async (args) => {
				const crew = deps.crew(input.projectId);
				if (!crew?.schedule)
					return "Schedules need the project's crew, which is not available here.";
				const now = deps.now();
				const result = await crew.schedule(args, {
					userId: input.userId,
					ySquaredId: input.selfId,
				});
				if (!result.ok) return `Not done: ${result.error}`;
				if (result.action === "list")
					return scheduleLines(result.schedules, now);
				if (result.action === "cancel")
					return result.cancelled
						? "Cancelled."
						: "No active schedule with that id.";
				const s = result.schedule;
				return [
					`Scheduled (id ${s.id}): "${s.prompt}" · ${describeSpec(s.spec, s.timezone)} · next ${
						s.nextDueAt === null
							? "never"
							: formatLocal(s.nextDueAt, s.timezone)
					} (${s.timezone}).`,
					result.usedUtcFallback
						? "No time zone is saved for this person, so UTC was used. Tell them once, and that opening this project's Y settings saves their browser's zone; a different zone can be set by cancelling and creating it again with a timezone."
						: "",
				]
					.filter(Boolean)
					.join("\n");
			},
		}),
		[Y_SQUARED_RETRY_THREAD_TOOL]: tool({
			description: Y_SQUARED_RETRY_THREAD_DESCRIPTION,
			inputSchema: retryThreadInput,
			execute: async ({ id }) => {
				if (!input.machines || !input.modelId) return noMachines;
				const chat = await ownThread(id);
				if (!chat) return noThread;
				if (chat.turnStatus !== "failed")
					return `"${chat.title}" did not fail on its last turn (it is ${chat.turnStatus}); nothing to retry.`;
				await markSent(chat.id);
				const text =
					"Your last turn failed. Retry it: continue where you stopped and finish the work.";
				const sent = await deps.send(
					input.machines,
					{
						userId: input.userId,
						projectId: input.projectId,
						sessionId: chat.id,
						harnessId: routeOf(chat).harnessId,
						createNew: false,
					},
					{
						text,
						modelId: routeOf(chat).modelId,
						idempotencyKey: sendKey("retry", chat.id, text),
					},
				);
				if (sent.failed) return `Not retried: ${sent.failed}`;
				return sent.turnStatus === "running"
					? `Retrying "${chat.title}": a new turn started.`
					: `Retry queued for "${chat.title}" behind the budget/concurrency limit; it starts by itself.`;
			},
		}),
		[Y_SQUARED_ARCHIVE_THREAD_TOOL]: tool({
			description: Y_SQUARED_ARCHIVE_THREAD_DESCRIPTION,
			inputSchema: archiveThreadInput,
			execute: async ({ id }) => {
				if (id === input.selfId) return noThread;
				const found = await deps.metadata(input.userId, id);
				if (!found || found.projectId !== input.projectId) return noThread;
				if (found.parentSessionId || found.agentRole)
					return `"${found.title}" is a helper chat (a ${found.agentRole ?? "child"} of another thread), not a thread of its own: it is not in the threads list and is archived with its parent thread.`;
				const chat = found;
				if (chat.turnStatus === "running")
					return `"${chat.title}" is working; stop it first if it should go.`;
				const row = await deps
					.crew(input.projectId)
					?.thread(id)
					.catch(() => null);
				if (row?.waitingOn && row.waitingOn !== "failed")
					return `"${chat.title}" is waiting on the person (${row.waitingOn}); not archived.`;
				if (row?.prUrl) {
					// A merged or closed pull request is no reason to keep it.
					const open = await deps
						.prOpen(input.userId, input.projectId, row.prUrl)
						.catch(() => null);
					if (open !== false)
						return open
							? `"${chat.title}" has an open pull request (${row.prUrl}); not archived.`
							: `"${chat.title}" has a pull request (${row.prUrl}) whose state could not be checked; not archived.`;
				}
				await deps.archive(input.userId, chat.id);
				return `Archived "${chat.title}". Settings > Archived restores it.`;
			},
		}),
		[Y_SQUARED_STOP_THREAD_TOOL]: tool({
			description: Y_SQUARED_STOP_THREAD_DESCRIPTION,
			inputSchema: stopThreadInput,
			execute: async ({ id }) => {
				if (!input.machines) return noMachines;
				const chat = await ownThread(id);
				if (!chat) return noThread;
				if (chat.turnStatus !== "running")
					return `"${chat.title}" is not running.`;
				await deps.stop(input.machines, {
					userId: input.userId,
					projectId: input.projectId,
					sessionId: chat.id,
					harnessId: chat.harness,
					createNew: false,
				});
				return `Stopped "${chat.title}". Messages already queued in it still go on.`;
			},
		}),
	};
}
