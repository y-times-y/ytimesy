import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
	parseRuntimeId as parseHarnessId,
} from "#/domain/agent-provider";
import { incomingAttachments } from "#/domain/message-attachment";
import { chatHoldingSend } from "#/server/adapters/agent-sessions";
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
	readHarnessWorkspaceSession,
} from "#/server/services/harness-workspace-session";
import {
	removeQueuedComposerMessage,
	sendComposerMessage,
	stopTurnKeepingQueue,
	withQueuedMessages,
} from "#/server/services/queued-user-messages";
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
			return withQueuedMessages(
				await Effect.runPromise(
					readHarnessWorkspaceSession({ ...scope, sessionId: landed }),
				),
			);
		}
		return withQueuedMessages(
			await Effect.runPromise(readHarnessWorkspaceSession(scope)),
		);
	});

export const getWorkspaceBootstrap = createServerFn({ method: "GET" }).handler(
	async () => {
		let user: Awaited<ReturnType<typeof requireUser>>;
		try {
			user = await requireUser(getRequest().headers);
		} catch (error) {
			if (!(error instanceof Response) || error.status !== 401) throw error;
			return {
				signedIn: false,
				session: emptyHarnessSession(),
				projects: undefined,
			};
		}
		const [snapshotAvailable, projects] = await Promise.all([
			hasManagedCodexAuth(user.id),
			listProjects(user.id).catch(() => undefined),
		]);
		return {
			signedIn: true,
			projects,
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
	},
);

/** Advances a pending ChatGPT sign-in; the composer polls this while it waits. */
export const pollCodexLogin = createServerFn({ method: "POST" }).handler(
	async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return advanceCodexDeviceLogin(user.id);
	},
);

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
				data.text.trim() ||
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
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(
			data.projectId,
			data.harnessId,
			data.sessionId,
			data.createNew,
		);
		await consumeUserAction(scope.userId, "chat-send");
		return withQueuedMessages(
			await runWithMachines((machines) =>
				sendComposerMessage(machines, scope, data),
			),
		);
	});

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
