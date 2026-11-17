import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
	parseRuntimeId as parseHarnessId,
} from "#/domain/agent-provider";
import { chatsFromAgentSessions, pinnedYSquared } from "#/domain/agent-session";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import { claudeSubscriptionEnabled } from "#/domain/claude-code-route";
import { savedDefaultBranchesFromCookies } from "#/domain/default-branch-cookie";
import { isEnvironmentSetupPrompt } from "#/domain/environment-setup";
import {
	type FirstRunState,
	firstRunDoneFromCookies,
} from "#/domain/first-run";
import { savedInspectorFromCookies } from "#/domain/inspector-split";
import { incomingAttachments } from "#/domain/message-attachment";
import { openChatFromCookies } from "#/domain/open-chat-cookie";
import { isValidBranchName } from "#/domain/session-branch";
import type { SessionReadDelta, SessionReadFull } from "#/domain/session-delta";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { chatOpenedWithProject } from "#/domain/sidebar-chats";
import { savedSidebarPrsFromCookies } from "#/domain/sidebar-pr-cookie";
import {
	TRANSCRIPT_PAGE_TURNS,
	type TranscriptPage,
} from "#/domain/transcript-page";
import { userHubEnabledFor } from "#/domain/user-hub";
import { xaiSubscriptionEnabled } from "#/domain/xai-subscription";
import {
	agentSessionMetadataForOwner,
	agentSessionPageForOwner,
	chatHoldingSend,
	chatToOpenMetadata,
	listSidebarAgentSessions,
} from "#/server/adapters/agent-sessions";
import { claudeSubscriptionStatus } from "#/server/adapters/claude-subscription";
import {
	firstRunFinished,
	markFirstRunFinished,
} from "#/server/adapters/first-run";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { listModelConnections } from "#/server/adapters/model-connections";
import { listProjects } from "#/server/adapters/projects";
import { consumeUserAction } from "#/server/adapters/user-action-rate";
import { ySquaredChatsByProject } from "#/server/adapters/y-mode";
import { loadAgentAccount } from "#/server/auth/agent-account";
import { requireUser } from "#/server/auth/auth";
import {
	advanceCodexDeviceLogin,
	startCodexDeviceLogin,
} from "#/server/auth/codex-device-login";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { githubConnectionExists } from "#/server/auth/github-connection";
import { requireSameOrigin } from "#/server/http";
import { readableServerError } from "#/server/public-error";
import { agentModelCatalog } from "#/server/services/agent-model-catalog";
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
import { saveSecretsPastedInMessage } from "#/server/services/project-secrets";
import {
	publicSessionView,
	releaseQueuedComposerMessage,
	removeQueuedComposerMessage,
	sendComposerMessage,
	stopTurnKeepingQueue,
	updateQueuedComposerMessage,
	withQueuedMessages,
} from "#/server/services/queued-user-messages";
import {
	readSessionFull,
	readSessionSince,
} from "#/server/services/session-delta";
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
 * The open chat since the browser's last read (`since`: the transcript token
 * that read came with): a small delta when it can be told exactly, else the
 * whole view with a fresh token (session-delta.ts). Without `since` it is
 * the whole view and the token to ask from next time.
 */
export const getCodexSessionDelta = createServerFn({ method: "GET" })
	.validator(
		(
			data:
				| (Parameters<typeof optionalSessionInput>[0] & {
						since?: { rev: number; count: number };
						fields?: boolean;
				  })
				| undefined,
		) => ({
			...optionalSessionInput(data),
			since: data?.since
				? z
						.object({
							rev: z.number().int().min(0),
							count: z.number().int().min(0),
						})
						.parse(data.since)
				: undefined,
			fields: data?.fields === true,
		}),
	)
	.handler(
		async ({
			data,
		}): Promise<SessionReadDelta | SessionReadFull<PublicCodexSession>> => {
			const scope = await optionalScope(
				data.projectId,
				data.harnessId,
				data.sessionId,
				data.createNew,
			);
			if (!scope)
				return {
					mode: "full",
					view: emptyHarnessSession(),
					token: null,
					queuedCount: 0,
				};
			return data.since
				? readSessionSince(scope, data.since, data.fields)
				: readSessionFull(scope);
		},
	);

/**
 * The turns before the oldest item the reader has (`before`), read as the
 * reader scrolls up. `found` is false when the chat no longer holds that
 * item (a restore rewrote it); the reader then reads the chat again.
 */
export const getOlderSessionItems = createServerFn({ method: "GET" })
	.validator((data: unknown) =>
		z
			.object({
				projectId: z.uuid(),
				sessionId: z.uuid(),
				before: z.string().min(1).max(500),
			})
			.parse(data),
	)
	.handler(async ({ data }): Promise<TranscriptPage & { found: boolean }> => {
		const user = await requireUser(getRequest().headers);
		const page = await agentSessionPageForOwner(user.id, data.sessionId, {
			turns: TRANSCRIPT_PAGE_TURNS,
			beforeId: data.before,
		});
		if (!page || page.projectId !== data.projectId)
			throw new Error("Session is not in this project.");
		return {
			items: childTaskPublicItems(sessionItemsFromUnknown(page.items)),
			hasOlderItems: page.hasOlderItems,
			found: page.pageFound,
		};
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

/**
 * The chat the page opens: the linked chat if it is listed, else the latest
 * that is not the project's setup chat (chatOpenedWithProject).
 */
function chatToOpen<
	Chat extends { readonly id: string; readonly title: string },
>(chats: readonly Chat[] | undefined, linkedChatId: string | undefined) {
	return (
		chats?.find((chat) => chat.id === linkedChatId) ??
		chatOpenedWithProject({ chats, composerDraft: false })
	);
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
	.handler(async ({ data: urlLink }) => {
		// No link: the chat this browser had open, so a reload stays in it.
		const link =
			urlLink.chatId || urlLink.projectId
				? urlLink
				: (openChatFromCookies(getRequest().headers.get("cookie")) ?? urlLink);
		let user: Awaited<ReturnType<typeof requireUser>>;
		try {
			user = await requireUser(getRequest().headers);
		} catch (error) {
			if (!(error instanceof Response) || error.status !== 401) throw error;
			return {
				signedIn: false,
				userId: undefined,
				session: emptyHarnessSession(),
				projects: undefined,
				chats: undefined,
				projectChats: undefined,
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
		// The open project (a linked chat's project, else the first).
		const openProjectId = listed.then(async (projects) => {
			const linkedProjectId = link.projectId ?? (await linkedChatProject);
			return (
				projects?.find((project) => project.id === linkedProjectId)?.id ??
				projects?.[0]?.id
			);
		});
		// Every project's chats come with the page: the sidebar orders its
		// projects and the Recent list by them, so the server's order is the
		// order the browser keeps (read in the browser, the projects reordered
		// as the page loaded).
		// A Y project's Y² chat is marked and pinned, as the browser's list read has it.
		const ySquaredChats = ySquaredChatsByProject(user.id).catch(
			() => new Map<string, string>(),
		);
		const sidebarChats = (projectId: string) =>
			listSidebarAgentSessions(user.id, projectId).then(async (sessions) =>
				pinnedYSquared(
					chatsFromAgentSessions(sessions),
					(await ySquaredChats).get(projectId),
				),
			);
		const projectChatReads = listed.then(
			(projects) =>
				new Map(
					(projects ?? []).map((project) => [
						project.id,
						sidebarChats(project.id),
					]),
				),
		);
		const otherChats = projectChatReads.then((reads) =>
			Promise.all(
				[...reads].map(([projectId, read]) =>
					read.then(
						(chats) => ({ projectId, chats }),
						() => undefined,
					),
				),
			),
		);
		// The open project's chats come with the page, so the chat it opens
		// starts loading as soon as the page runs instead of after a list read.
		const firstChats = openProjectId
			.then(async (projectId) => {
				if (!projectId) return undefined;
				const read = (await projectChatReads).get(projectId);
				return {
					projectId,
					chats: await (read ?? sidebarChats(projectId)),
				};
			})
			.catch(() => undefined);
		// What the open chat shows beside its items (helpers, recovery rows)
		// renders with it. A linked chat's starts at once, in
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
		// The chat it opens (the one chatToOpen picks from that list) is found
		// by a small read beside the list, not after it: the list reads every
		// chat's last turn.
		const openChat = openProjectId
			.then(async (projectId) => {
				if (!projectId) return undefined;
				const chat = await chatToOpenMetadata(user.id, projectId, link.chatId);
				if (!chat) return undefined;
				const early = await linkedSide;
				const side =
					early?.projectId === projectId && early.sessionId === chat.id
						? early.side
						: openChatSide(user.id, projectId, chat.id);
				const harnessId = chat.harness ?? DEFAULT_COMPOSER_HARNESS_ID;
				const [view, sideData] = await Promise.all([
					publicSessionView({
						userId: user.id,
						projectId,
						harnessId,
						sessionId: chat.id,
					}),
					side,
				]);
				if (!view) return view;
				// Without the view's models the composer would name the model by
				// its id until the browser reads the catalog.
				const models = view.models.length
					? undefined
					: await agentModelCatalog(user.id, harnessId).catch(() => undefined);
				return {
					...view,
					side: models?.length
						? { ...sideData, catalog: { harnessId, models } }
						: sideData,
				};
			})
			.catch(() => undefined);
		// A new account (no project yet) opens the first-run steps at the right
		// one, until it leaves them: then the composer's picker adds a project.
		const setupDone = firstRunDoneFromCookies(
			getRequest().headers.get("cookie"),
			user.id,
		);
		// The cookie answers at once on this browser; the account's record
		// covers every other browser.
		const firstRun = listed.then(async (projects) =>
			projects &&
			projects.length === 0 &&
			!setupDone &&
			!(await firstRunFinished(user.id).catch(() => false))
				? firstRunState(user.id).catch(() => undefined)
				: undefined,
		);
		const [snapshotAvailable, projects, chats, projectChats, firstRunAt] =
			await Promise.all([
				hasManagedCodexAuth(user.id),
				listed,
				firstChats,
				otherChats.catch(() => []),
				firstRun,
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
			// The browser's chat cache belongs to this user (chat-cache.ts).
			userId: user.id,
			projects,
			chats,
			// The server renders this chat open, as the browser would open it;
			// a slow read streams in after the rest of the page.
			openChatView,
			openChatId: chatToOpen(chats?.chats, link.chatId)?.id,
			// The other projects' chats, for the sidebar's project order and Recent list.
			projectChats: projectChats.flatMap((group) =>
				group && group.projectId !== chats?.projectId ? [group] : [],
			),
			// The sidebar's account button renders from this.
			account: { name: user.name, email: user.email, image: user.image },
			firstRun: firstRunAt,
			// The right panel as this browser left it.
			inspector: savedInspectorFromCookies(getRequest().headers.get("cookie")),
			// A new chat's "from <branch>" as this browser last read it from GitHub.
			savedDefaultBranches: savedDefaultBranchesFromCookies(
				getRequest().headers.get("cookie"),
			),
			// The sidebar's PR icons as this browser last read them from GitHub.
			savedPullRequests: savedSidebarPrsFromCookies(
				getRequest().headers.get("cookie"),
			),
			// Relative times render from this on the server and while hydrating.
			renderedAtMs: Date.now(),
			// The page opens the user's hub socket instead of polling running chats.
			userHub: userHubEnabledFor(process.env.YTIMESY_USER_HUB_USERS, user.id),
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

/** Where a new account stands: GitHub connected, and a model to run chats on. */
async function firstRunState(userId: string): Promise<FirstRunState> {
	const claudeSubscription = claudeSubscriptionEnabled();
	const [githubConnected, account, connections, claude] = await Promise.all([
		githubConnectionExists(userId),
		loadAgentAccount(userId),
		listModelConnections(userId),
		claudeSubscription
			? claudeSubscriptionStatus(userId).catch(() => null)
			: null,
	]);
	return {
		githubConnected,
		modelReady:
			account.status === "connected" ||
			connections.length > 0 ||
			claude?.status === "connected" ||
			claude?.status === "limited",
		...(xaiSubscriptionEnabled() ? { xaiSubscription: true } : {}),
		...(claudeSubscription ? { claudeSubscription: true } : {}),
	};
}

/** Starts ChatGPT sign-in for the account, outside any chat (first run, settings). */
export const startChatgptSignIn = createServerFn({ method: "POST" })
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return startCodexDeviceLogin(user.id);
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
		try {
			const scope = await requireScope(
				data.projectId,
				data.harnessId,
				data.sessionId,
				data.createNew,
			);
			return withQueuedMessages(
				await Effect.runPromise(connectHarnessWorkspaceSession(scope)),
			);
		} catch (cause) {
			throw await readableServerError(cause);
		}
	});

/** About 100k tokens; a longer paste belongs in an attached file. */
const messageText = z
	.string()
	.max(400_000, "Message is too long; attach long text as a file instead.");

const baseBranchInput = z
	.string()
	.trim()
	.max(255)
	.refine(isValidBranchName, "Choose a valid branch to start from.");

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
			/** The route's alternate context window, when it offers one. */
			alternateContext?: boolean;
			approvesPlan?: boolean;
			/** Continue on the fallback route the user approved (`<connection>|<model>`). */
			continueOn?: string;
			attachments?: unknown;
			/** The client's id for the message; a replayed send with it is not queued twice. */
			userMessageId?: string;
			/** The branch a new chat starts from; the server checks it on GitHub. */
			baseBranch?: string;
			/** A project setup request: the chat becomes a setup chat. */
			environmentSetup?: boolean;
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
				// Likewise its context window.
				alternateContext: data.alternateContext === true,
				...(data.approvesPlan === true ? { approvesPlan: true } : {}),
				...(data.continueOn
					? { continueOn: failoverRouteKey.parse(data.continueOn) }
					: {}),
				...(attachments.length ? { attachments } : {}),
				...(data.userMessageId
					? { idempotencyKey: z.string().uuid().parse(data.userMessageId) }
					: {}),
				...(data.baseBranch === undefined
					? {}
					: { baseBranch: baseBranchInput.parse(data.baseBranch) }),
				// The chip's request sent unedited counts too (an older tab, the API).
				...(data.environmentSetup === true || isEnvironmentSetupPrompt(text)
					? { environmentSetup: true }
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
				const text = data.projectId
					? await saveSecretsPastedInMessage({
							userId: scope.userId,
							projectId: data.projectId,
							text: data.text,
						})
					: data.text;
				const sent = await runWithMachines((machines) =>
					sendComposerMessage(machines, scope, { ...data, text }),
				);
				return timed("send:queued", () => withQueuedMessages(sent));
			}).catch(async (cause: unknown) => {
				// A thrown Response (GitHub not connected) would reach the client as "{}".
				throw await readableServerError(cause);
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

/** Replaces a waiting message's text. A step that already took it is unchanged. */
export const updateQueuedSessionMessage = createServerFn({ method: "POST" })
	.validator(
		(
			data: Parameters<typeof optionalSessionInput>[0] & {
				messageId: string;
				text: string;
				/** "Fix with the agent" on a message held for setup. */
				environmentSetup?: boolean;
			},
		) => ({
			...optionalSessionInput(data),
			messageId: z.string().uuid().parse(data.messageId),
			text: messageText.parse(data.text),
			environmentSetup: data.environmentSetup === true,
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
			updateQueuedComposerMessage(
				scope,
				data.messageId,
				data.text,
				data.environmentSetup,
			),
		);
	});

/**
 * Send on a waiting message. A running turn is not interrupted; the message
 * goes out at the next step. A finished turn starts now.
 */
export const releaseQueuedSessionMessage = createServerFn({ method: "POST" })
	.validator(
		(
			data: Parameters<typeof optionalSessionInput>[0] & {
				messageId: string;
				text?: string;
			},
		) => ({
			...optionalSessionInput(data),
			messageId: z.string().uuid().parse(data.messageId),
			...(data.text !== undefined
				? { text: messageText.parse(data.text) }
				: {}),
		}),
	)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(
			data.projectId,
			data.harnessId,
			data.sessionId,
			data.createNew,
		);
		return runWithMachines((machines) =>
			releaseQueuedComposerMessage(machines, scope, data.messageId, data.text),
		);
	});

/** Leaving the first run: recorded on the account, so every browser skips it. */
export const finishFirstRunFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		await markFirstRunFinished(user.id);
		return { ok: true };
	},
);
