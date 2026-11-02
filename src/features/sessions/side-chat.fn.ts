import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import {
	type AgentProviderId,
	parseRuntimeId as parseHarnessId,
} from "#/domain/agent-provider";
import { publicFailureMessage } from "#/domain/project-workspace";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { consumeUserAction } from "#/server/adapters/user-action-rate";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { withPublicFailure } from "#/server/public-failure";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import { readSideChat, sendSideChatMessage } from "#/server/services/side-chat";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const sideChatInput = z.object({
	projectId: z.uuid(),
	parentSessionId: z.uuid(),
	harnessId: z.string().max(64),
});

function runWithMachines<A>(run: (machines: WorkspaceMachines) => Promise<A>) {
	return withPublicFailure("Side chat", publicFailureMessage, async () =>
		run(
			await Effect.runPromise(
				WorkspaceMachineService.pipe(
					Effect.provide(FreestyleWorkspaceMachinesLive),
				),
			),
		),
	);
}

export const readSideChatFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => {
		const parsed = sideChatInput.parse(data);
		return { ...parsed, harnessId: parseHarnessId(parsed.harnessId) };
	})
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		return readSideChat({ userId: user.id, ...data });
	});

export const sendSideChatFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => {
		const parsed = sideChatInput
			.extend({
				modelId: z.string().trim().min(1).max(512),
				text: z.string().trim().min(1).max(400_000),
				userMessageId: z.uuid(),
				variant: z.string().trim().max(64).optional(),
				speed: z.enum(["standard", "fast", "ultrafast"]).optional(),
				alternateContext: z.boolean().optional(),
			})
			.parse(data);
		return {
			...parsed,
			harnessId: parseHarnessId(parsed.harnessId),
			...(parsed.variant ? { variant: parsed.variant } : {}),
			...(parsed.speed && parsed.speed !== "standard"
				? { speed: parsed.speed }
				: {}),
		};
	})
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		await consumeUserAction(user.id, "chat-send");
		return runWithMachines((machines) =>
			sendSideChatMessage(machines, {
				userId: user.id,
				projectId: data.projectId,
				parentSessionId: data.parentSessionId,
				harnessId: data.harnessId as AgentProviderId,
				modelId: data.modelId,
				text: data.text,
				idempotencyKey: data.userMessageId,
				...(data.variant ? { variant: data.variant } : {}),
				...("speed" in data && data.speed ? { speed: data.speed } : {}),
				...(data.alternateContext !== undefined
					? { alternateContext: data.alternateContext }
					: {}),
			}),
		);
	});
