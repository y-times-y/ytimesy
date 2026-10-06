import { apiTurnFailureClassification } from "#/domain/api-turn-failure";
import { SessionItemId } from "#/domain/ids";
import { posixShellCommand } from "#/domain/posix-command";
import type { SessionItem } from "#/domain/session-item";
import { taskVerificationPlan } from "#/domain/task-integration-checks";
import {
	assertPatchIdentity,
	type TaskPatchIdentity,
} from "#/domain/task-patch-evidence";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	saveAgentSessionItems,
	saveAgentTaskState,
} from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import { taskPatchEvidence } from "../adapters/task-patch-evidence";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import {
	bindPreparedAgentTaskMachine,
	prepareAgentTaskStart,
} from "./agent-session-machine";
import { scopedShellCommand, stopApiTurnCommands } from "./api-command-scope";
import { deferredApiTurnWorkspace } from "./api-turn-workspace";
import {
	captureTaskPatch,
	importReviewedTaskChanges,
} from "./reviewed-task-import";
import { machinesForAgentSession } from "./session-workspace-machines";
import { commitCompletedSessionTurn } from "./turn-commit";
import type { WorkspaceMachines } from "./workspace-machines";

const BASE_CHECKS = `import json, subprocess, sys
def git(*args): return subprocess.check_output(['git',*args],text=True)
base=sys.argv[1]
if git('rev-parse','HEAD').strip()!=base: raise ValueError('Integration checkout differs from the reviewed base')
def contents(path):
    present=subprocess.run(['git','cat-file','-e',base+':'+path],capture_output=True)
    return git('show',base+':'+path) if present.returncode==0 else None
print(json.dumps({'recipe':contents('.ytimesy/environment.json'),'manifest':contents('package.json'),'files':git('ls-tree','--name-only',base).splitlines()}))`;

const INTEGRATION_STAGES = {
	recording: "recording integration progress",
	binding: "preparing the isolated workspace",
	policy: "reading baseline verification policy",
	importing: "importing exact reviewed patches",
	checking: "running combined project checks",
	handoff: "capturing the combined patch and handoff",
} as const;

function verificationPreview(text: string, nextStart: number | null) {
	const characters = Array.from(text);
	return {
		content: characters.slice(0, 2048).join(""),
		nextStart: characters.length > 2048 ? 2048 : nextStart,
	};
}

export function baselineTaskVerificationCommand(
	directory: string,
	base: string,
) {
	if (!/^[a-f0-9]{40,64}$/.test(base))
		throw new Error("Invalid integration base revision.");
	return `cd ${posixShellCommand([directory])} && ${posixShellCommand(["python3", "-c", BASE_CHECKS, base])}`;
}

/** Executes a draft, not a model turn. Any uncertain or failed operation preserves the checkout for agent repair. */
export async function integrateTaskDraft(
	machines: WorkspaceMachines,
	parent: AgentSessionRecord,
	destinationId: string,
	sources: readonly TaskPatchIdentity[],
	control: { signal: AbortSignal; turnId: string },
) {
	control.signal.throwIfAborted();
	if (
		parent.parentSessionId ||
		parent.candidateIndex != null ||
		!parent.projectId
	)
		throw new Error(
			"Only a non-competing root lead may request automated integration.",
		);
	if (
		sources.length < 2 ||
		sources.length > 8 ||
		new Set(sources.map((source) => source.taskId)).size !== sources.length
	)
		throw new Error("Choose two to eight distinct reviewed sibling tasks.");
	for (const source of sources) assertPatchIdentity(source);
	if (sources.some((source) => source.base !== sources[0].base))
		throw new Error("All reviewed siblings must share one base revision.");
	const destination = await agentSessionForOwner(parent.userId, destinationId);
	if (
		!destination ||
		destination.parentSessionId !== parent.id ||
		destination.projectId !== parent.projectId ||
		destination.taskState !== "draft" ||
		destination.providerRef ||
		destination.taskAccess !== "read_write" ||
		destination.taskPlacement !== "fresh" ||
		destination.taskExecution !== "parallel" ||
		destination.candidateIndex != null
	)
		throw new Error(
			"Automated integration requires a fresh writable direct-child draft.",
		);
	const evidence = await taskPatchEvidence(parent.userId, [parent.id]);
	for (const source of sources) {
		const accepted = evidence.reviews.get(source.taskId);
		const sibling = await agentSessionForOwner(parent.userId, source.taskId);
		if (
			!accepted ||
			accepted.sha256 !== source.sha256 ||
			accepted.base !== source.base ||
			!sibling ||
			sibling.parentSessionId !== parent.id ||
			sibling.projectId !== parent.projectId ||
			sibling.taskState !== "done" ||
			sibling.taskReviewState !== "reviewed" ||
			sibling.taskAccess !== "read_write" ||
			sibling.candidateIndex != null
		)
			throw new Error(
				"Every source must be an exact reviewed, completed sibling.",
			);
	}
	const { task, predecessor } = await prepareAgentTaskStart({
		userId: parent.userId,
		projectId: parent.projectId,
		taskSessionId: destinationId,
	});
	const targetMachines = machinesForAgentSession(machines, task);
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId(`${control.turnId}:integration`),
			text:
				task.taskPrompt ??
				"Integrate reviewed sibling patches and run baseline project checks.",
		},
	];
	let workspace:
		| Awaited<ReturnType<ReturnType<typeof deferredApiTurnWorkspace>>>
		| undefined;
	let stopping: Promise<void> | undefined;
	const stop = () => {
		if (workspace)
			stopping ??= stopApiTurnCommands(workspace, control.turnId).catch(
				() => {},
			);
	};
	control.signal.addEventListener("abort", stop, { once: true });
	let persistence: Promise<unknown> = Promise.resolve();
	const persist = () => {
		const snapshot = [...items];
		persistence = persistence.then(() =>
			saveAgentSessionItems(
				task.id,
				snapshot,
				undefined,
				task.listedModelId,
				"running",
			),
		);
		return persistence;
	};
	let stage: keyof typeof INTEGRATION_STAGES = "recording";
	try {
		await persist();
		stage = "binding";
		await bindPreparedAgentTaskMachine(targetMachines, {
			userId: parent.userId,
			projectId: parent.projectId,
			task,
			predecessor,
		});
		const bound = await agentSessionForOwner(parent.userId, task.id);
		if (!bound) throw new Error("Integration workspace disappeared.");
		workspace = await deferredApiTurnWorkspace(
			targetMachines,
			bound,
			control.signal,
		)();
		control.signal.throwIfAborted();
		stage = "policy";
		const policy = await workspace.machines.exec(
			workspace.vm,
			baselineTaskVerificationCommand(workspace.cwd, sources[0].base),
			15000,
		);
		if (policy.exitCode)
			throw new Error("Could not read baseline verification policy.");
		const verificationPlan = taskVerificationPlan(JSON.parse(policy.stdout));
		const commands = verificationPlan.flat();
		stage = "importing";
		for (const source of sources) {
			control.signal.throwIfAborted();
			const result = await importReviewedTaskChanges(
				targetMachines,
				bound,
				source.taskId,
				source.sha256,
				workspace,
			);
			items.push({
				kind: "dynamicToolCall",
				id: SessionItemId(`${task.id}:import:${source.taskId}`),
				tool: "import_reviewed_task",
				input: JSON.stringify(source),
				output: JSON.stringify(result),
				status: "completed",
			});
			await persist();
		}
		stage = "policy";
		const policyChanges = await workspace.machines.exec(
			workspace.vm,
			`cd ${posixShellCommand([workspace.cwd])} && git diff --name-only ${sources[0].base} -- package.json .ytimesy/environment.json pnpm-lock.yaml yarn.lock package-lock.json bun.lock bun.lockb`,
			15000,
		);
		if (policyChanges.exitCode || policyChanges.stdout.trim())
			throw new Error(
				"Verification policy or dependency configuration changed. Inspect and verify this integration with an agent rather than automatically executing changed check scripts.",
			);
		stage = "checking";
		const verificationWorkspace = workspace;
		const artifacts = agentOutputArtifacts({
			...verificationWorkspace,
			sessionId: task.id,
			signal: control.signal,
		});
		const checkResults: {
			command: string;
			reference: string;
			exitCode: number;
			stopped: "timeout" | "output_limit" | null;
			stdout: string;
			stderr: string;
			stdoutNextStart: number | null;
			stderrNextStart: number | null;
		}[] = [];
		let checkIndex = 0;
		const runCheck = async (command: string) => {
			const index = checkIndex++;
			control.signal.throwIfAborted();
			const item: SessionItem = {
				kind: "commandExecution",
				id: SessionItemId(`${task.id}:check:${index}`),
				command,
				cwd: verificationWorkspace.cwd,
				status: "inProgress",
				output: null,
				exitCode: null,
			};
			items.push(item);
			const itemIndex = items.length - 1;
			await persist();
			const result = await artifacts.capture(
				scopedShellCommand({
					turnId: control.turnId,
					cwd: verificationWorkspace.cwd,
					command,
					seconds: 120,
				}),
				125,
			);
			const stdout = verificationPreview(result.stdout, result.stdoutNextStart);
			const stderr = verificationPreview(result.stderr, result.stderrNextStart);
			const receipt = {
				command,
				reference: result.reference,
				exitCode: result.exitCode,
				stopped: result.stopped,
				stdout: stdout.content,
				stderr: stderr.content,
				stdoutNextStart: stdout.nextStart,
				stderrNextStart: stderr.nextStart,
			};
			checkResults[index] = receipt;
			items[itemIndex] = {
				...item,
				status:
					result.exitCode === 0 && !result.stopped ? "completed" : "failed",
				output: `${result.stdout}${result.stderr}`.slice(-32000),
				exitCode: result.exitCode,
			};
			items.push({
				kind: "dynamicToolCall",
				id: SessionItemId(`${task.id}:check-evidence:${index}`),
				tool: "integration_check_evidence",
				input: JSON.stringify({ command }),
				output: JSON.stringify(receipt),
				status:
					result.exitCode === 0 && !result.stopped ? "completed" : "failed",
			});
			await persist();
			control.signal.throwIfAborted();
			if (result.exitCode || result.stopped)
				throw new Error(
					"Combined project checks failed; continue this integration task with an agent. All started checks settled; later checks were not run after failure.",
				);
		};
		for (const group of [
			["git diff --check && git diff --cached --check"],
			...verificationPlan,
		]) {
			// Explicit independence only; cap guest pressure at two concurrent checks.
			for (let offset = 0; offset < group.length; offset += 2) {
				const results = await Promise.allSettled(
					group.slice(offset, offset + 2).map(runCheck),
				);
				const failed = results.find((result) => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			}
		}
		stage = "handoff";
		const patch = await captureTaskPatch(workspace.machines, workspace.vm);
		items.push({
			kind: "agentMessage",
			id: SessionItemId(`${task.id}:result`),
			text: `Server integration completed. All baseline project checks passed. The combined patch still requires the lead's exact-diff review. Retained verification receipts: ${JSON.stringify(checkResults)}. Each stdout/stderr preview is complete when its corresponding nextStart is null; do not reread complete unchanged output. Otherwise read the remaining output with read_task_output using this task ID, reference, stream and nextStart; follow continuation cursors. These references belong to this integration task, not the lead's machine. Do not rerun successful checks merely to retrieve their output.`,
		});
		control.signal.throwIfAborted();
		await commitCompletedSessionTurn(bound, items);
		await saveAgentSessionItems(
			task.id,
			items,
			undefined,
			task.listedModelId,
			"completed",
		);
		await saveAgentTaskState(task.id, "done");
		await saveAgentTaskResultAndEvent({
			sessionId: task.id,
			turnId: control.turnId,
			eventType: "completed",
			summary:
				"Server integration completed with baseline checks passing. Inspect the combined diff before accepting it.",
		});
		return {
			taskId: task.id,
			status: "done",
			reviewRequired: true,
			sha256: patch.sha256,
			base: patch.base,
			checks: commands,
			checkResults,
		};
	} catch (error) {
		stop();
		await stopping;
		const classification = apiTurnFailureClassification(error);
		const reason = `Automated integration stopped while ${INTEGRATION_STAGES[stage]}. Inspect this task's recorded imports and command output, then repair in the same child; no uncertain operation was replayed.`;
		items.push({
			kind: "error",
			id: SessionItemId(`${task.id}:failure`),
			message: `${reason} Diagnostic: ${classification.name}/${classification.code}.`,
		});
		await saveAgentSessionItems(
			task.id,
			items,
			undefined,
			task.listedModelId,
			"failed",
		);
		await saveAgentTaskState(task.id, "failed");
		await saveAgentTaskResultAndEvent({
			sessionId: task.id,
			turnId: control.turnId,
			eventType: "failed",
			summary: reason,
		});
		return {
			taskId: task.id,
			status: "failed",
			repairRequired: true,
			stage,
			reason,
			classification,
		};
	} finally {
		control.signal.removeEventListener("abort", stop);
		await stopping;
	}
}
