import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import { leaderCount } from "#/domain/agent-competition";
import { parseRuntimeId } from "#/domain/agent-provider";
import { parallelAttemptModelIds } from "#/domain/model-attempts";
import {
	competitionsForOwner,
	createAgentCompetition,
	markCompetitionStatus,
} from "#/server/adapters/agent-competitions";
import { loadAgentModelCatalog } from "#/server/adapters/agent-model-catalog";
import { agentSessionForOwner } from "#/server/adapters/agent-sessions";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { requireSameOrigin } from "#/server/http";
import { enqueueCompetition } from "#/server/jobs/queue";
import { stopAgentCompetitionRun } from "#/server/services/agent-competition-run";
import { apiModelCatalog } from "#/server/services/api-workspace-session";
import { WorkspaceMachineService } from "#/server/services/capabilities";

export const getAgentCompetitions = createServerFn({ method: "GET" })
	.validator((data: { rootSessionId?: string } | undefined) => ({
		rootSessionId: data?.rootSessionId?.trim() ?? "",
	}))
	.handler(async ({ data }) => {
		if (!data.rootSessionId) return [];
		const user = await requireUser(getRequest().headers);
		return competitionsForOwner(user.id, data.rootSessionId);
	});

export const startAgentCompetition = createServerFn({ method: "POST" })
	.validator(
		(data: {
			projectId: string;
			rootSessionId: string;
			text: string;
			harnessId: string;
			modelId: string;
			modelIds?: readonly string[];
			leaderCount: number;
			userMessageId: string;
		}) => ({
			projectId: data.projectId.trim(),
			rootSessionId: data.rootSessionId.trim(),
			text: data.text.trim(),
			harnessId: parseRuntimeId(data.harnessId),
			modelId: data.modelId.trim(),
			modelIds: data.modelIds?.map((id) => id.trim()),
			leaderCount: leaderCount.parse(data.leaderCount),
			userMessageId: z.string().uuid().parse(data.userMessageId),
		}),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const attempts = parallelAttemptModelIds(data);
		if (!attempts.ok) throw new Error(attempts.message);
		if (!data.text || !data.projectId || !data.rootSessionId)
			throw new Error(
				"Choose a project, model, and task before starting agents.",
			);
		if (data.harnessId === "claude")
			throw new Error(
				"Use a connected subscription or API model for independent agents.",
			);
		const root = await agentSessionForOwner(user.id, data.rootSessionId);
		if (!root || root.projectId !== data.projectId || root.parentSessionId)
			throw new Error("Start independent agents from a project chat.");
		if (data.harnessId === "codex" && !(await hasManagedCodexAuth(user.id)))
			throw new Error("Connect your Codex subscription first.");
		const catalog =
			data.harnessId === "codex"
				? await loadAgentModelCatalog(user.id, "codex")
				: await apiModelCatalog(user.id);
		const available = new Set(catalog.map((model) => model.id));
		if (attempts.modelIds.some((id) => !available.has(id)))
			throw new Error(
				data.harnessId === "codex"
					? "Choose currently available Codex models for each agent."
					: "Choose verified API models for each agent.",
			);
		const group = await createAgentCompetition({
			userId: user.id,
			projectId: data.projectId,
			rootSessionId: root.id,
			prompt: data.text,
			harness: data.harnessId,
			modelId: data.modelId,
			modelIds: attempts.modelIds,
			leaderCount: data.leaderCount,
			userMessageId: data.userMessageId,
		});
		try {
			const jobId = await enqueueCompetition(root.id);
			if (!jobId) throw new Error("Could not queue independent agents.");
		} catch (error) {
			await markCompetitionStatus(
				root.id,
				"failed",
				"Could not queue independent agents.",
			);
			throw error;
		}
		return group;
	});

export const stopAgentCompetition = createServerFn({ method: "POST" })
	.validator((data: { rootSessionId: string }) => ({
		rootSessionId: data.rootSessionId.trim(),
	}))
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return Effect.runPromise(
			Effect.gen(function* () {
				const machines = yield* WorkspaceMachineService;
				return yield* Effect.tryPromise(() =>
					stopAgentCompetitionRun(machines, user.id, data.rootSessionId),
				);
			}).pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
		);
	});
