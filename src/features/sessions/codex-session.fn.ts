import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
	parseRuntimeId as parseHarnessId,
} from "#/domain/agent-provider";
import { chatsFromAgentSessions } from "#/domain/agent-session";
import { savedInspectorFromCookies } from "#/domain/inspector-split";
import { incomingAttachments } from "#/domain/message-attachment";
import {
	agentSessionMetadataForOwner,
	chatHoldingSend,
	listSidebarAgentSessions,
} from "#/server/adapters/agent-sessions";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { listProjects } from "#/server/adapters/projects";
import { consumeUserAction } from "#/server/adapters/user-action-rate";
import { requireUser } from "#/server/auth/auth";
import { advanceCodexDeviceLogin } from "#/server/auth/codex-device-login";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { requireSameOrigin } from "#/server/http";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	connectHarnessWorkspaceSession,
	emptyHarnessSession,
	type HarnessSessionScope,
} from "#/server/services/harness-workspace-session";
import {
	type OpenChatSide,
	openChatSide,
} from "#/server/services/open-chat-side";
import {
	publicSessionView,
	removeQueuedComposerMessage,
	sendComposerMessage,
	stopTurnKeepingQueue,
	withQueuedMessages,
} from "#/server/services/queued-user-messages";
import { timed, withStepTrace } from "#/server/services/step-timing";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

/** A fallback route's key: the connection ("codex" or a connection id), then the model. */
const failoverRouteKey = z
	.string()
	.max(600)
	.regex(
		/^(codex|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|.+$/i,
	);

function runWithMachines<A>(
	run: (machines: WorkspaceMachines) => Effect.Effect<A>,
): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const machines = yield* WorkspaceMachineService;
			return yield* run(machines);
		}).pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
	);
}

async function optionalScope(
	projectId?: string,
	harnessId: AgentProviderId = DEFAULT_COMPOSER_HARNESS_ID,
	sessionId?: string,
	createNew?: boolean,
): Promise<HarnessSessionScope | null> {
	try {
		const user = await requireUser(getRequest().headers);
		return { userId: user.id, projectId, harnessId, sessionId, createNew };
	} catch {
		return null;
	}
}

async function requireScope(
	projectId?: string,
	harnessId: AgentProviderId = DEFAULT_COMPOSER_HARNESS_ID,
	sessionId?: string,
	createNew?: boolean,
): Promise<HarnessSessionScope> {
	requireSameOrigin(getRequest());
	const user = await requireUser(getRequest().headers);
	return { userId: user.id, projectId, harnessId, sessionId, createNew };
}

function optionalSessionInput(
	data:
		| {
				projectId?: string;
				harnessId?: string;
				sessionId?: string;
				createNew?: boolean;
		  }
		| undefined,
) {
	const projectId =
		typeof data?.projectId === "string" ? data.projectId.trim() : "";
	const sessionId =
		typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
	const harnessId = data?.harnessId
		? parseHarnessId(data.harnessId)
		: DEFAULT_COMPOSER_HARNESS_ID;
	return {
		projectId: projectId || undefined,
		sessionId: sessionId || undefined,
		createNew: data?.createNew === true,
		harnessId,
	};
}

export const getCodexSession = createServerFn({ method: "GET" })
	.validator(
		(
			data:
				| (Parameters<typeof optionalSessionInput>[0] & {
						/** Without a chat id: the chat that queued this message, if any. */
						userMessageId?: string;
				  })
				| undefined,
		) => ({
			...optionalSessionInput(data),
			...(data?.userMessageId
				? { userMessageId: z.string().uuid().parse(data.userMessageId) }
				: {}),
		}),
	)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await optionalScope(
			data.projectId,
			data.harnessId,
			data.sessionId,
			data.createNew,
		);
		if (!scope) return emptyHarnessSession();
		// A new chat's first send: find the chat it landed in, if it did.
		if (!scope.sessionId && data.userMessageId) {
			const landed = scope.projectId
				? await chatHoldingSend(
						scope.userId,
						scope.projectId,
						data.userMessageId,
					)
				: null;
			if (!landed) return emptyHarnessSession();
			return publicSessionView({ ...scope, sessionId: landed });
		}
		return publicSessionView(scope);
	});

/**
 * How long the page's first bytes wait for its open chat's view (the linked
 * chat, else the latest) after its other reads: within it the chat renders
 * in the page's first HTML. Past it the page streams without the chat and
 * the chat follows in the same response, until OPEN_CHAT_GIVE_UP_MS; then
 * the browser reads it.
 */
const OPEN_CHAT_WAIT_MS = 250;
const OPEN_CHAT_GIVE_UP_MS = 8_000;

/** The chat the page opens, with what its transcript shows beside its items. */
export type OpenChatView = PublicCodexSession & {
	readonly side?: OpenChatSide;
};

/** An open chat read past OPEN_CHAT_WAIT_MS: the page streams it in. */
export type StreamedChatView = Promise<OpenChatView | undefined>;

/** The chat the page opens: the linked chat if it is listed, else the latest. */
function chatToOpen<Chat extends { readonly id: string }>(
	chats: readonly Chat[] | undefined,
	linkedChatId: string | undefined,
) {
	return chats?.find((chat) => chat.id === linkedChatId) ?? chats?.[0];
}

/** The read, or undefined once `ms` pass first. */
function within<T>(read: Promise<T>, ms: number) {
	let timer: number | undefined;
	return Promise.race([
		read,
		new Promise<undefined>((resolve) => {
			timer = setTimeout(resolve, ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** A chat link (`/?chat=<id>`, `/?project=<id>&chat=<id>`): the chat the page opens. */
const linkedChatInput = z
	.object({
		chatId: z.string().uuid().optional(),
		projectId: z.string().uuid().optional(),
	})
	.optional()
	.catch(undefined);

export const getWorkspaceBootstrap = createServerFn({ method: "GET" })
	.validator((data: unknown) => linkedChatInput.parse(data) ?? {})
	.handler(async ({ data: link }) => {
		let user: Awaited<ReturnType<typeof requireUser>>;
		try {
			user = await requireUser(getRequest().headers);
		} catch (error) {
			if (!(error instanceof Response) || error.status !== 401) throw error;
			return {
				signedIn: false,
				session: emptyHarnessSession(),
				projects: undefined,
				chats: undefined,
				renderedAtMs: Date.now(),
			};
		}
		const listed = listProjects(user.id).catch(() => undefined);
		// A linked chat without its project: the project it belongs to.
		const linkedChatProject =
			link.chatId && !link.projectId
				? agentSessionMetadataForOwner(user.id, link.chatId)
						.then((chat) => chat?.projectId)
						.catch(() => undefined)
				: undefined;
		// The open project's chats come with the page (a linked chat's
		// project, else the first), so the chat it opens starts loading as
		// soon as the page runs instead of after a list read.
		const firstChats = listed
			.then(async (projects) => {
				const linkedProjectId = link.projectId ?? (await linkedChatProject);
				const projectId =
					projects?.find((project) => project.id === linkedProjectId)?.id ??
					projects?.[0]?.id;
				if (!projectId) return undefined;
				return {
					projectId,
					chats: chatsFromAgentSessions(
						await listSidebarAgentSessions(user.id, projectId),
					),
				};
			})
			.catch(() => undefined);
		// What the open chat shows beside its items (helpers, evidence,
		// recovery rows) renders with it. A linked chat's starts at once, in
		// parallel with the reads before the view, so it does not hold the view.
		const linkedSideProject = link.chatId
			? (link.projectId ?? linkedChatProject)
			: undefined;
		const linkedSide =
			link.chatId && linkedSideProject
				? Promise.resolve(linkedSideProject).then((projectId) =>
						projectId && link.chatId
							? {
									projectId,
									sessionId: link.chatId,
									side: openChatSide(user.id, projectId, link.chatId),
								}
							: undefined,
					)
				: undefined;
		const openChat = firstChats
			.then(async (first) => {
				const chat = chatToOpen(first?.chats, link.chatId);
				if (!first || !chat) return undefined;
				const early = await linkedSide;
				const side =
					early?.projectId === first.projectId && early.sessionId === chat.id
						? early.side
						: openChatSide(user.id, first.projectId, chat.id);
				const [view, sideData] = await Promise.all([
					publicSessionView({
						userId: user.id,
						projectId: first.projectId,
						harnessId: chat.harnessId ?? DEFAULT_COMPOSER_HARNESS_ID,
						sessionId: chat.id,
					}),
					side,
				]);
				return view && { ...view, side: sideData };
			})
			.catch(() => undefined);
		const [snapshotAvailable, projects, chats] = await Promise.all([
			hasManagedCodexAuth(user.id),
			listed,
			firstChats,
		]);
		// Landed in time, the view comes as a value: the browser hydrates it
		// without waiting on a promise.
		let landed: { view: OpenChatView | undefined } | undefined;
		const streamed: StreamedChatView = within(
			openChat.catch(() => undefined),
			OPEN_CHAT_GIVE_UP_MS,
		).then((view) => {
			landed = { view };
			return view;
		});
		await within(streamed, OPEN_CHAT_WAIT_MS);
		const settled = landed as typeof landed | undefined;
		const openChatView = settled ? settled.view : streamed;
		return {
			signedIn: true,
			projects,
			chats,
			// The server renders this chat open, as the browser would open it;
			// a slow read streams in after the rest of the page.
			openChatView,
			openChatId: chatToOpen(chats?.chats, link.chatId)?.id,
			// The sidebar's account button renders from this.
			account: { name: user.name, email: user.email, image: user.image },
			// The right panel as this browser left it.
			inspector: savedInspectorFromCookies(getRequest().headers.get("cookie")),
			// Relative times render from this on the server and while hydrating.
			renderedAtMs: Date.now(),
			session: {
				...emptyHarnessSession(),
				snapshotAvailable,
				...(snapshotAvailable
					? {
							connection: {
								status: "authenticated" as const,
								provider: "codex" as const,
								authMode: "chatgpt" as const,
								planType: null,
								email: null,
							},
							canSend: true,
						}
					: {}),
			},
		};
	});

/** Advances a pending ChatGPT sign-in; the composer polls this while it waits. */
export const pollCodexLogin = createServerFn({ method: "POST" })
	// An empty object, so the call has the JSON body requireSameOrigin needs.
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return advanceCodexDeviceLogin(user.id);
	});

export const connectCodexSession = createServerFn({ method: "POST" })
	.validator(optionalSessionInput)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(
			data.projectId,
			data.harnessId,
			data.sessionId,
			data.createNew,
		);
		return withQueuedMessages(
			await Effect.runPromise(connectHarnessWorkspaceSession(scope)),
		);
	});

/** About 100k tokens; a longer paste belongs in an attached file. */
const messageText = z
	.string()
	.max(400_000, "Message is too long; attach long text as a file instead.");

export const sendCodexSessionTask = createServerFn({ method: "POST" })
	.validator(
		(data: {
			text: string;
			modelId: string;
			projectId?: string;
			harnessId?: string;
			sessionId?: string;
			createNew?: boolean;
			variant?: string;
			fast?: boolean;
			speed?: string;
			approvesPlan?: boolean;
			/** Continue on the fallback route the user approved (`<connection>|<model>`). */
			continueOn?: string;
			attachments?: unknown;
			/** The client's id for the message; a replayed send with it is not queued twice. */
			userMessageId?: string;
		}) => {
			const attachments =
				data.attachments === undefined
					? []
					: incomingAttachments.parse(data.attachments);
			const text =
				messageText.parse(data.text).trim() ||
				(attachments.length ? "See the attached files." : "");
			const modelId = data.modelId.trim();
			if (!text) throw new Error("Task text is required");
			const variant = data.variant?.trim();
			return {
				text,
				modelId,
				projectId: data.projectId?.trim() || undefined,
				harnessId: data.harnessId
					? parseHarnessId(data.harnessId)
					: DEFAULT_COMPOSER_HARNESS_ID,
				sessionId: data.sessionId?.trim() || undefined,
				createNew: data.createNew === true,
				...(variant ? { variant } : {}),
				...(data.fast === true ? { fast: true } : {}),
				// A user send always states its speed, so it never inherits one.
				speed:
					data.speed === "fast"
						? ("fast" as const)
						: data.speed === "ultrafast"
							? ("ultrafast" as const)
							: ("standard" as const),
				...(data.approvesPlan === true ? { approvesPlan: true } : {}),
				...(data.continueOn
					? { continueOn: failoverRouteKey.parse(data.continueOn) }
					: {}),
				...(attachments.length ? { attachments } : {}),
				...(data.userMessageId
					? { idempotencyKey: z.string().uuid().parse(data.userMessageId) }
					: {}),
			};
		},
	)
	.handler(
		async ({ data }): Promise<PublicCodexSession> =>
			// Development diagnostics: one timing line per send (step-timing.ts).
			withStepTrace({ send: data.sessionId ? "chat" : "new" }, async () => {
				const scope = await timed("send:auth", () =>
					requireScope(
						data.projectId,
						data.harnessId,
						data.sessionId,
						data.createNew,
					),
				);
				await timed("send:rate", () =>
					consumeUserAction(scope.userId, "chat-send"),
				);
				const sent = await runWithMachines((machines) =>
					sendComposerMessage(machines, scope, data),
				);
				return timed("send:queued", () => withQueuedMessages(sent));
			}),
	);

export const stopCodexSessionTurn = createServerFn({ method: "POST" })
	.validator(optionalSessionInput)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(
			data.projectId,
			data.harnessId,
			data.sessionId,
			data.createNew,
		);
		return runWithMachines((machines) => stopTurnKeepingQueue(machines, scope));
	});

/** Takes back a message still waiting behind the running turn. */
export const removeQueuedSessionMessage = createServerFn({ method: "POST" })
	.validator(
		(
			data: Parameters<typeof optionalSessionInput>[0] & { messageId: string },
		) => ({
			...optionalSessionInput(data),
			messageId: z.string().uuid().parse(data.messageId),
		}),
	)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(
			data.projectId,
			data.harnessId,
			data.sessionId,
			data.createNew,
		);
		return Effect.runPromise(
			removeQueuedComposerMessage(scope, data.messageId),
		);
	});
