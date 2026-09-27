import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { parseHarnessId } from "#/server/secrets/harness-key-store";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	completeClaudeWorkspaceAuth,
	connectHarnessWorkspaceSession,
	emptyHarnessSession,
	type HarnessSessionScope,
	readHarnessWorkspaceSession,
	sendHarnessWorkspaceTask,
	stopHarnessWorkspaceTurn,
} from "#/server/services/harness-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

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
	.validator(optionalSessionInput)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await optionalScope(
			data.projectId,
			data.harnessId,
			data.sessionId,
			data.createNew,
		);
		if (!scope) return emptyHarnessSession();
		return runWithMachines((machines) =>
			readHarnessWorkspaceSession(machines, scope),
		);
	});

export const getWorkspaceBootstrap = createServerFn({ method: "GET" }).handler(
	async () => {
		let user;
		try {
			user = await requireUser(getRequest().headers);
		} catch (error) {
			if (!(error instanceof Response) || error.status !== 401) throw error;
			return { signedIn: false, session: emptyHarnessSession() };
		}
		return {
			signedIn: true,
			session: {
				...emptyHarnessSession(),
				snapshotAvailable: await hasManagedCodexAuth(user.id),
			},
		};
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
		return runWithMachines((machines) =>
			connectHarnessWorkspaceSession(machines, scope),
		);
	});

export const completeClaudeSessionAuth = createServerFn({ method: "POST" })
	.validator(
		(data: {
			code: string;
			projectId?: string;
			sessionId?: string;
			createNew?: boolean;
		}) => {
			const code = data.code.trim();
			if (!code) throw new Error("Paste the login code from Anthropic's page.");
			return {
				...optionalSessionInput({
					projectId: data.projectId,
					sessionId: data.sessionId,
					createNew: data.createNew,
					harnessId: "claude",
				}),
				code,
			};
		},
	)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(
			data.projectId,
			"claude",
			data.sessionId,
			data.createNew,
		);
		return runWithMachines((machines) =>
			completeClaudeWorkspaceAuth(machines, scope, data.code),
		);
	});

export const sendCodexSessionTask = createServerFn({ method: "POST" })
	.validator(
		(data: {
			text: string;
			modelId: string;
			lane?: "main" | "side";
			projectId?: string;
			harnessId?: string;
			sessionId?: string;
			createNew?: boolean;
			variant?: string;
			fast?: boolean;
		}) => {
			const text = data.text.trim();
			const modelId = data.modelId.trim();
			if (!text) throw new Error("Task text is required");
			const variant = data.variant?.trim();
			return {
				text,
				modelId,
				lane: data.lane === "side" ? ("side" as const) : ("main" as const),
				projectId: data.projectId?.trim() || undefined,
				harnessId: data.harnessId
					? parseHarnessId(data.harnessId)
					: DEFAULT_COMPOSER_HARNESS_ID,
				sessionId: data.sessionId?.trim() || undefined,
				createNew: data.createNew === true,
				...(variant ? { variant } : {}),
				...(data.fast === true ? { fast: true } : {}),
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
		return runWithMachines((machines) =>
			sendHarnessWorkspaceTask(machines, scope, data),
		);
	});

export const stopCodexSessionTurn = createServerFn({ method: "POST" })
	.validator(
		(
			data:
				| {
						projectId?: string;
						harnessId?: string;
						sessionId?: string;
						createNew?: boolean;
						lane?: "main" | "side";
				  }
				| undefined,
		) => ({
			...optionalSessionInput(data),
			lane: data?.lane === "side" ? ("side" as const) : ("main" as const),
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
			stopHarnessWorkspaceTurn(machines, scope, { lane: data.lane }),
		);
	});
