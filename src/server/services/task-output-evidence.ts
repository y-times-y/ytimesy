import { z } from "zod";
import { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	agentOutputArtifacts,
	agentOutputPageSchema,
} from "./agent-output-artifacts";
import { completedAgentCommands } from "./api-agent-command-tools";
import type { WorkspaceMachines } from "./workspace-machines";

const evidencePageSchema = agentOutputPageSchema.extend({
	background: z.boolean().default(false),
});

/** Caller resolves the task from the owner's descendant tree before entering this read-only path. */
export async function readAuthorizedTaskOutput(input: {
	machines: WorkspaceMachines;
	task: AgentSessionRecord;
	ownerId: string;
	projectId: string;
	page: unknown;
	signal: AbortSignal;
}) {
	const { task, machines, signal } = input;
	if (task.userId !== input.ownerId || task.projectId !== input.projectId)
		throw new Error("Task evidence is not available in this project.");
	const request = evidencePageSchema.parse(input.page);
	if (!task.providerRef)
		throw new Error("The task has no retained output machine.");
	signal.throwIfAborted();
	const vm = WorkspaceId(task.providerRef);
	await machines.ensureRunning(vm);
	const workspace = { machines, vm, cwd: "/" };
	const page = await agentOutputArtifacts({
		...workspace,
		sessionId: task.id,
		signal,
	}).read(request);
	if (!request.background) return page;
	const completion = await completedAgentCommands({
		...workspace,
		signal,
		sessionId: task.id,
		ids: [request.reference],
	});
	return { ...page, completion: completion[0] ?? { status: "running" } };
}
