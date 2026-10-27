import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import { agentSessionForOwner } from "#/server/adapters/agent-sessions";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { stopBackgroundCommandForUser } from "#/server/services/background-command-notices";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import { runningBackgroundCommandsByChat } from "#/server/services/running-background-commands";

/**
 * The running background commands of up to 20 of the user's chats (a chat
 * and its subagents), by chat id, for the agents list. As the timelines
 * record them: an exit reaches a chat's timeline at its agent's next step,
 * or between turns within seconds (its exit callback; the cron within a minute).
 */
export const readBackgroundCommandsFn = createServerFn({ method: "GET" })
	.validator((data: unknown) =>
		z.object({ sessionIds: z.array(z.uuid()).min(1).max(20) }).parse(data),
	)
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		return runningBackgroundCommandsByChat(user.id, data.sessionIds);
	});

/** The user stops one background command of their chat; its card shows it ended within a minute. */
export const stopBackgroundCommandFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ sessionId: z.uuid(), commandId: z.uuid() }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const session = await agentSessionForOwner(user.id, data.sessionId);
		if (!session) throw new Error("Chat not found.");
		return Effect.runPromise(
			Effect.gen(function* () {
				const machines = yield* WorkspaceMachineService;
				return yield* Effect.promise(() =>
					stopBackgroundCommandForUser(machines, session, data.commandId),
				);
			}).pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
		);
	});
