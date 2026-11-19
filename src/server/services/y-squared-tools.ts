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
} from "#/domain/canvas-text";
import {
	attachmentSizeLabel,
	isViewableImage,
	type MessageAttachment,
} from "#/domain/message-attachment";
import { wakeMessageId } from "#/domain/pull-request-wake";
import type { SessionItem } from "#/domain/session-item";
import { threadOutcomeLines } from "#/domain/thread-outcome";
import {
	messageThreadInput,
	readCanvasInput,
	showCanvasInput,
	startThreadInput,
	stopThreadInput,
	threadsOverview,
	threadTimesText,
	Y_SQUARED_MAX_STARTS_PER_TURN,
	Y_SQUARED_MESSAGE_THREAD_DESCRIPTION,
	Y_SQUARED_MESSAGE_THREAD_TOOL,
	Y_SQUARED_READ_CANVAS_DESCRIPTION,
	Y_SQUARED_READ_CANVAS_TOOL,
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
import { latestCanvasForOwner } from "../adapters/canvas-read";
import { downloadMessageAttachment } from "../adapters/checkpoints/storage";
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
	) => Promise<{ readonly turnStatus: string; readonly failed?: string }>;
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
			...(view.connection.status === "failed"
				? { failed: view.connection.message }
				: {}),
		};
	},
	stop: async (machines, scope) => {
		const view = await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
		return { turnStatus: view.turnStatus };
	},
};

type Sidebar = Awaited<ReturnType<typeof listSidebarAgentSessions>>[number];

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
	const noThread = "No such thread in this project.";
	const noMachines = "Threads cannot be run here.";
	const noCanvas = (thread: string, title: string) =>
		`"${thread}" has no canvas titled "${title}" (or its document is no longer stored). Call \`thread\` to see its canvases.`;
	const staleNote = (found: { revision: number; latestRevision: number }) =>
		found.latestRevision > found.revision
			? `(The thread's newest revision ${found.latestRevision} no longer has its document stored; this is revision ${found.revision}, the latest that does.)`
			: "";
	/** Metadata of the project's threads: the cold start and where no crew exists. */
	const fromSidebar = async () =>
		(await deps.list(input.userId, input.projectId))
			.filter((chat) => chat.id !== input.selfId && !chat.unused)
			.slice(0, Y_SQUARED_THREAD_LIMIT)
			.map(rowFromSidebar);
	/** The crew's rows; an empty, never-filled crew is filled once from the sidebar. */
	const crewRows = async (): Promise<CrewRow[]> => {
		const crew = deps.crew(input.projectId);
		if (!crew) return fromSidebar();
		const listed = await crew.list();
		const rows = listed.rows.filter((row) => row.sessionId !== input.selfId);
		if (rows.length || listed.reconciled) return rows;
		const seeded = await fromSidebar();
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
				const row = crew
					? await crew.thread(id)
					: (await fromSidebar()).find((entry) => entry.sessionId === id);
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
			execute: async ({ id, title, part }) => {
				const chat = await ownThread(id);
				if (!chat) return noThread;
				const name = canvasTitle(title);
				const found = await deps.canvas(input.userId, chat.id, name);
				if (!found) return noCanvas(chat.title, name);
				// Never more than a canvas may hold; only text leaves this function.
				const html = found.html.slice(0, CANVAS_HTML_LIMIT);
				const page = canvasOutlinePage(canvasOutline(html), part ?? 1);
				return [
					`Canvas "${found.title}" of "${chat.title}": revision ${found.revision}, ${canvasSizeKb(found.html.length)} KB${canvasHasImages(html) ? ", has images" : ""}; part ${page.part} of ${page.parts}.`,
					staleNote(found),
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
					value: `${canvasConfirmation(shown.title, shown.revision)} It is thread ${shown.ownerThreadId}'s canvas: the person can preview it and pin notes here; feedback on it goes back to that thread.`,
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
			execute: async ({ title, brief, attachments }) => {
				if (!input.machines || !input.modelId || !input.harnessId)
					return noMachines;
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
						harnessId: input.harnessId,
						createNew: true,
					},
					{
						// The first line names the chat (sessionTitleFromText).
						text: `${title}\n\n${brief}`,
						modelId: input.modelId,
						idempotencyKey: sendKey(
							"start",
							title,
							brief,
							...(attachments ?? []),
						),
						...(forward.files ? { attachments: forward.files } : {}),
					},
				);
				if (sent.failed) return `Not started: ${sent.failed}`;
				return sent.turnStatus === "running"
					? `Started "${title}". You wake when it finishes or needs the person.`
					: `Queued "${title}" behind the budget/concurrency limit; it starts by itself when there is room. You wake when it finishes or needs the person.`;
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
						harnessId: chat.harness,
						createNew: false,
					},
					{
						text,
						modelId: chat.listedModelId ?? input.modelId,
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
