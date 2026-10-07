import { z } from "zod";
import { WorkspaceId } from "#/domain/ids";
import {
	type ProjectSourceEvidence,
	sourceEvidenceContentsMatch,
	sourceEvidenceFileHashesMatch,
} from "#/domain/project-source-evidence";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	agentOutputArtifacts,
	agentOutputPageSchema,
} from "./agent-output-artifacts";
import { completedAgentCommands } from "./api-agent-command-tools";
import { inspectProjectSourceEvidence } from "./project-source-evidence";
import type { WorkspaceMachines } from "./workspace-machines";

const evidencePageSchema = agentOutputPageSchema.extend({
	background: z.boolean().default(false),
});

export function requireCurrentTaskCheck(evidence: unknown) {
	const result = z
		.object({
			completion: z.object({ status: z.literal(0), stopped: z.null() }),
			verification: z.object({ sourcesStable: z.literal(true) }),
			sourcesCurrent: z.literal(true),
		})
		.safeParse(evidence);
	if (!result.success)
		throw new Error(
			"Verification must have a zero exit, no stop, and current unchanged declared sources.",
		);
}

/** Foreground checks share fresh source observations; no status is inferred from output text. */
export async function readAuthorizedTaskChecks(input: {
	machines: WorkspaceMachines;
	task: AgentSessionRecord;
	ownerId: string;
	projectId: string;
	references: unknown;
	signal: AbortSignal;
}) {
	const { task, machines, signal } = input;
	if (task.userId !== input.ownerId || task.projectId !== input.projectId)
		throw new Error("Task evidence is not available in this project.");
	const references = z.array(z.uuid()).min(1).max(8).parse(input.references);
	if (new Set(references).size !== references.length)
		throw new Error("Check references must be distinct.");
	if (!task.providerRef)
		throw new Error("The task has no retained output machine.");
	signal.throwIfAborted();
	const vm = WorkspaceId(task.providerRef);
	await machines.ensureRunning(vm);
	const workspace = { machines, vm, cwd: "/" };
	const pages = await agentOutputArtifacts({
		...workspace,
		sessionId: task.id,
		signal,
	}).readBundle(references);
	const sourceProofs: Array<{
		cwd: string;
		before: ProjectSourceEvidence;
		after: ProjectSourceEvidence;
		sourcesStable: boolean;
		sourcesCurrent: boolean;
		checkedRevision: string | null;
	}> = [];
	const proofIndices = new Map<string, number>();
	const checks = [];
	for (const { stdout, stderr } of pages) {
		const verification = stdout.verification;
		if (
			JSON.stringify(verification) !== JSON.stringify(stderr.verification) ||
			JSON.stringify(stdout.completion) !== JSON.stringify(stderr.completion)
		)
			throw new Error("Check receipt changed during bundle observation.");
		let sourceProof: number | null = null;
		if (verification) {
			const { cwd, before, after } = verification;
			const key = JSON.stringify({ cwd, before, after });
			sourceProof = proofIndices.get(key) ?? null;
			if (sourceProof === null) {
				signal.throwIfAborted();
				const current = await inspectProjectSourceEvidence(
					{ ...workspace, cwd },
					after.sources.map((source) => source.path),
					true,
				);
				const sourcesStable = sourceEvidenceContentsMatch(before, after);
				sourceProof = sourceProofs.length;
				proofIndices.set(key, sourceProof);
				sourceProofs.push({
					cwd,
					before,
					after,
					sourcesStable,
					sourcesCurrent:
						sourcesStable && sourceEvidenceFileHashesMatch(after, current),
					checkedRevision: current.revision,
				});
			}
		}
		const {
			verification: _stdoutProof,
			completion: _stdoutCompletion,
			...stdoutOutput
		} = stdout;
		const {
			verification: _stderrProof,
			completion: _stderrCompletion,
			...stderrOutput
		} = stderr;
		checks.push({
			reference: stdout.reference,
			command: verification?.command ?? null,
			completion: stdout.completion ?? null,
			sourceProof,
			stdout: stdoutOutput,
			stderr: stderrOutput,
		});
	}
	return { sourceProofs, checks };
}

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
	if (page.verification) {
		const current = await inspectProjectSourceEvidence(
			{ ...workspace, cwd: page.verification.cwd },
			page.verification.after.sources.map((source) => source.path),
			true,
		);
		page.verification.sourcesStable = sourceEvidenceContentsMatch(
			page.verification.before,
			page.verification.after,
		);
		Object.assign(page, {
			sourcesCurrent:
				page.verification.sourcesStable &&
				sourceEvidenceFileHashesMatch(page.verification.after, current),
			checkedRevision: current.revision,
		});
	}
	if (!request.background) return page;
	const completion = await completedAgentCommands({
		...workspace,
		signal,
		sessionId: task.id,
		ids: [request.reference],
	});
	return { ...page, completion: completion[0] ?? { status: "running" } };
}
