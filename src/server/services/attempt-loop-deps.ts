import type { RoleModels } from "#/domain/role-models";
import type { SessionItem } from "#/domain/session-item";
import { readerCommand } from "#/domain/subagent-reader";
import {
	type AgentSessionRecord,
	descendantAgentSessions,
} from "../adapters/agent-sessions";
import {
	attemptLoopDeadline,
	latestReviewLoopState,
	loadAttemptLoopState,
	loadReviewLoopState,
	loopSubagentStatus,
	saveAttemptLoopState,
	saveReviewLoopState,
	takeLoopSubagentReport,
} from "../adapters/attempt-loop-store";
import { requestSubagentStop } from "../adapters/subagents";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { scopedShellCommand, stopApiCommand } from "./api-command-scope";
import type { AttemptLoopDeps } from "./attempt-loop";
import { pendingAgentCommandIds } from "./background-command-context";
import { captureConversationCode } from "./conversation-code-checkpoint";
import type { ReviewLoopDeps } from "./review-loop";
import { startRuntimeSubagent } from "./subagent-tools";
import type { WorkspaceMachines } from "./workspace-machines";

/** The attempt loop's production wiring (tests pass fakes to createAttemptLoop). */
export function attemptLoopDeps(input: {
	/** Unscoped: the checker's session is addressed on the same VM. */
	readonly machines: WorkspaceMachines;
	readonly parent: AgentSessionRecord;
	readonly turnId: string;
	readonly workspace: () => Promise<AgentToolWorkspace>;
	readonly signal: AbortSignal;
	readonly waitDeadlineAt?: number;
	readonly items: () => readonly SessionItem[];
	/** The checker's and judge's models (harness variant roleModels). */
	readonly roleModels?: RoleModels;
	/** The builder turn's reasoning effort (children on another model inherit it). */
	readonly parentReasoning?: string;
}): AttemptLoopDeps {
	const { turnId, signal } = input;
	return {
		now: () => Date.now(),
		sleep: (ms, abort) =>
			new Promise((resolve) => {
				const timer = setTimeout(done, ms);
				function done() {
					clearTimeout(timer);
					abort.removeEventListener("abort", done);
					resolve();
				}
				abort.addEventListener("abort", done, { once: true });
			}),
		load: loadAttemptLoopState,
		save: saveAttemptLoopState,
		runnerDeadline: attemptLoopDeadline,
		capture: (workspace, ref) => captureConversationCode(workspace, ref),
		startSubagent: (spec) =>
			startRuntimeSubagent(
				{
					machines: input.machines,
					parent: input.parent,
					workspace: input.workspace,
					signal,
					waitDeadlineAt: input.waitDeadlineAt,
					roleModels: input.roleModels,
					parentReasoning: input.parentReasoning,
				},
				spec,
			),
		takeReport: takeLoopSubagentReport,
		childItems: async (id) => (await loopSubagentStatus(id))?.items ?? [],
		stopChild: requestSubagentStop,
		vm: async (command, timeoutMs) => {
			const workspace = await input.workspace();
			return workspace.machines.exec(workspace.vm, command, timeoutMs);
		},
		routed: async (command, seconds) => {
			const workspace = await input.workspace();
			const output = await agentOutputArtifacts({
				...workspace,
				sessionId: turnId,
				signal,
			}).capture(
				scopedShellCommand({ command, turnId, cwd: workspace.cwd, seconds }),
				seconds + 2,
			);
			return {
				exitCode: output.exitCode,
				stdout: output.stdout,
				stderr: output.stderr,
			};
		},
		stopOwnedCommands: async () => {
			const workspace = await input.workspace();
			for (const id of pendingAgentCommandIds(input.items()))
				await stopApiCommand(workspace, turnId, id).catch(() => {});
		},
	};
}

/** The review loop's production wiring: the attempt loop's plumbing with its own state. */
export function reviewLoopDeps(
	input: Parameters<typeof attemptLoopDeps>[0],
): ReviewLoopDeps {
	const { load: _load, save: _save, ...shared } = attemptLoopDeps(input);
	return {
		...shared,
		load: loadReviewLoopState,
		save: saveReviewLoopState,
		latest: latestReviewLoopState,
		// The loop re-runs a checker's tests with its access: as the reader user.
		checkerExec: (checkerSessionId, command, timeoutMs) =>
			shared.vm(readerCommand(checkerSessionId, command), timeoutMs),
		workers: async (checkerSessionId) =>
			(
				await descendantAgentSessions(input.parent.userId, checkerSessionId)
			).map((session) => ({
				sessionId: session.id,
				...(session.listedModelId &&
				(session.harness === "codex" || session.harness === "api")
					? {
							model: {
								harness: session.harness,
								modelId: session.listedModelId,
							},
						}
					: {}),
				items: session.items,
			})),
	};
}
