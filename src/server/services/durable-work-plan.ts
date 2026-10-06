import { createHash, randomUUID } from "node:crypto";
import { Effect, Either } from "effect";
import {
	type DurableWorkPlan,
	validateWorkPlan,
} from "#/domain/durable-work-plan";
import { WorkspaceId } from "#/domain/ids";
import {
	availableChildSlots,
	ChildAdmissionDenied,
} from "../adapters/agent-capacity";
import {
	type AgentSessionRecord,
	agentSessionById,
	agentSessionForOwner,
} from "../adapters/agent-sessions";
import { taskPatchEvidence } from "../adapters/task-patch-evidence";
import {
	claimWorkPlan,
	insertWorkPlan,
	notifyBlockedWorkPlan,
	renewWorkPlanClaim,
	saveClaimedWorkPlan,
	taskHasDurableLaunch,
} from "../adapters/work-plans";
import { enqueueAgentTaskEvent, enqueueWorkPlan } from "../jobs/queue";
import { integrateTaskDraft } from "./automated-task-integration";
import { startPreparedAgentTask } from "./harness-workspace-session";
import { captureTaskPatch } from "./reviewed-task-import";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

function draftContract(task: AgentSessionRecord) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				task.id,
				task.userId,
				task.projectId,
				task.parentSessionId,
				task.taskPrompt,
				task.listedModelId,
				task.harness,
				task.taskPlacement,
				task.taskAccess,
				task.taskExecution,
				task.dependsOnSessionId,
				task.selectedBranch,
				task.baseBranch,
			]),
		)
		.digest("hex");
}

function assertLead(parent: AgentSessionRecord) {
	if (parent.parentSessionId || parent.candidateIndex !== null)
		throw new Error(
			"Only a non-competing root lead may schedule durable work.",
		);
}

export async function scheduleDurableWork(
	parent: AgentSessionRecord,
	requestId: string,
	raw: unknown,
) {
	assertLead(parent);
	const { request, schedule } = validateWorkPlan(raw);
	const nodes: DurableWorkPlan["nodes"] = [];
	for (const node of request.tasks) {
		const task = await agentSessionForOwner(parent.userId, node.taskId);
		if (
			!task ||
			task.projectId !== parent.projectId ||
			task.parentSessionId !== parent.id ||
			task.taskState !== "draft" ||
			task.providerRef ||
			task.candidateIndex !== null ||
			task.taskPlacement !== "fresh" ||
			task.taskAccess !== "read_write" ||
			!task.taskPrompt ||
			!task.listedModelId ||
			!["api", "codex"].includes(task.harness) ||
			(await taskHasDurableLaunch(task.id))
		)
			throw new Error(
				"Each node must reference an untouched, fresh writable API or Codex sibling draft with an explicitly selected model.",
			);
		const predecessor = request.tasks.find(
			(candidate) => candidate.id === node.dependsOn[0],
		);
		if (node.kind === "task" && node.dependsOn.length === 1) {
			if (
				task.taskExecution !== "stacked" ||
				task.dependsOnSessionId !== predecessor?.taskId
			)
				throw new Error(
					"A dependent task must be stacked on its one declared predecessor.",
				);
		} else if (task.taskExecution !== "parallel" || task.dependsOnSessionId)
			throw new Error(
				"Independent tasks and integration nodes must be parallel drafts.",
			);
		nodes.push({
			...node,
			contract: draftContract(task),
			priority:
				schedule.schedule.find((entry) => entry.id === node.id)
					?.criticalPathSeconds ?? 0,
			state: "pending",
			message: null,
		});
	}
	const id = createHash("sha256")
		.update(JSON.stringify([parent.id, requestId]))
		.digest("hex");
	const plan = await insertWorkPlan(parent.userId, parent.id, {
		type: "work-plan",
		id,
		status: "active",
		lease: null,
		nodes,
	});
	await enqueueWorkPlan();
	return plan;
}

/** Queue state or completed work proves launch; a reservation alone never proves provider acceptance. */
export async function observePlanNode(
	node: DurableWorkPlan["nodes"][number],
	task: AgentSessionRecord | null,
	launched: boolean,
	reviewed: boolean,
) {
	if (node.state === "uncertain" || node.state === "failed") return node.state;
	if (!task) return "failed" as const;
	if (task.taskState === "failed" || task.turnStatus === "failed")
		return "failed" as const;
	if (
		(node.state === "dispatching" || task.taskState === "draft") &&
		!(launched || task.taskState === "done")
	)
		return "uncertain" as const;
	if (
		task.taskState === "done" &&
		task.taskReviewState === "reviewed" &&
		reviewed
	)
		return "done" as const;
	return "started" as const;
}

export async function dispatchDurableWork(machines: WorkspaceMachines) {
	const claim = await claimWorkPlan();
	if (!claim) return { status: "idle" };
	const { parentId, token, plan } = claim;
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), 25 * 60_000);
	const heartbeat = setInterval(() => {
		void renewWorkPlanClaim(parentId, plan.id, token).catch(() =>
			abort.abort(),
		);
	}, 20_000);
	heartbeat.unref();
	const save = () => saveClaimedWorkPlan(parentId, token, plan);
	const notify = async () => {
		if (plan.status !== "blocked") return;
		const parent = await agentSessionById(parentId);
		if (parent) {
			const eventId = await notifyBlockedWorkPlan(
				parent.userId,
				parentId,
				plan,
			);
			if (eventId) await enqueueAgentTaskEvent(eventId);
		}
	};
	try {
		const parent = await agentSessionById(parentId);
		if (!parent) throw new Error("The lead is unavailable.");
		assertLead(parent);
		if (parent.turnStatus === "failed" || parent.taskState === "failed") {
			plan.status = "paused";
			await saveClaimedWorkPlan(parentId, token, plan, true);
			return { status: "paused" };
		}
		const tasks = new Map<string, AgentSessionRecord | null>();
		for (const node of plan.nodes)
			tasks.set(
				node.id,
				await agentSessionForOwner(parent.userId, node.taskId),
			);
		const evidence = await taskPatchEvidence(parent.userId, [parent.id]);
		for (const node of plan.nodes) {
			const task = tasks.get(node.id) ?? null;
			if (node.state !== "pending") {
				node.state = await observePlanNode(
					node,
					task,
					await taskHasDurableLaunch(node.taskId),
					evidence.reviews.has(node.taskId),
				);
				if (node.state === "uncertain")
					node.message =
						"Interrupted launch has no durable acceptance proof. Inspect this task; it was not replayed.";
			} else if (
				!task ||
				draftContract(task) !== node.contract ||
				task.taskState !== "draft" ||
				task.providerRef ||
				(await taskHasDurableLaunch(node.taskId))
			) {
				node.state = "uncertain";
				node.message =
					"The draft changed or started outside this plan. No replacement was launched.";
			}
		}
		const exactReview = async (node: DurableWorkPlan["nodes"][number]) => {
			const task = tasks.get(node.id);
			const reviewed = evidence.reviews.get(node.taskId);
			if (
				!task?.providerRef ||
				!reviewed ||
				task.taskState !== "done" ||
				task.taskReviewState !== "reviewed"
			)
				throw new Error("Reviewed prerequisite is unavailable.");
			const current = await captureTaskPatch(
				machinesForAgentSession(machines, task),
				WorkspaceId(task.providerRef),
			);
			if (current.base !== reviewed.base || current.sha256 !== reviewed.sha256)
				throw new Error(
					"Reviewed prerequisite changed. Review the current exact patch before dispatch.",
				);
			return reviewed;
		};
		if (
			plan.nodes.some(
				(node) => node.state === "failed" || node.state === "uncertain",
			)
		)
			plan.status = "blocked";
		if (
			plan.status === "active" &&
			plan.nodes.every((node) => node.state === "done")
		) {
			for (const node of plan.nodes) await exactReview(node);
			plan.status = "completed";
		}
		if (plan.status !== "active") {
			await saveClaimedWorkPlan(parentId, token, plan, true);
			await notify();
			return { status: plan.status };
		}
		await save();
		let slots = await availableChildSlots(parent.userId, parent.id);
		const ready = plan.nodes
			.filter(
				(node) =>
					node.state === "pending" &&
					node.dependsOn.every(
						(id) =>
							plan.nodes.find((dependency) => dependency.id === id)?.state ===
							"done",
					),
			)
			.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
		for (const node of ready) {
			if (slots <= 0) break;
			abort.signal.throwIfAborted();
			const latest = await agentSessionForOwner(parent.userId, node.taskId);
			if (
				latest?.taskState !== "draft" ||
				draftContract(latest) !== node.contract ||
				latest.providerRef
			) {
				node.state = "uncertain";
				node.message = "Draft changed before dispatch.";
				plan.status = "blocked";
				break;
			}
			const sources = [];
			for (const dependency of node.dependsOn) {
				const prerequisite = plan.nodes.find(
					(candidate) => candidate.id === dependency,
				);
				if (!prerequisite) throw new Error("Missing prerequisite.");
				sources.push(await exactReview(prerequisite));
			}
			node.state = "dispatching";
			await save();
			try {
				if (node.kind === "integration") {
					const result = await integrateTaskDraft(
						machines,
						parent,
						node.taskId,
						sources,
						{
							signal: abort.signal,
							turnId: randomUUID(),
							expectedDraft: latest,
						},
					);
					if (result.status !== "done")
						throw new Error("Integration preserved a failed repair checkout.");
				} else {
					const started = await Effect.runPromise(
						Effect.either(
							startPreparedAgentTask(
								machines,
								{
									userId: parent.userId,
									projectId: parent.projectId,
									sessionId: parent.id,
									harnessId: parent.harness,
								},
								node.taskId,
								latest,
							),
						),
					);
					if (Either.isLeft(started)) throw started.left;
				}
				node.state = "started";
				slots--;
			} catch (error) {
				const observed = await agentSessionForOwner(parent.userId, node.taskId);
				if (
					error instanceof ChildAdmissionDenied &&
					observed?.taskState === "draft"
				) {
					node.state = "pending";
					node.message = "Waiting for atomic account admission.";
					slots = 0;
				} else {
					node.state =
						observed?.taskState === "failed" ? "failed" : "uncertain";
					node.message =
						"Dispatch failed or became uncertain. Inspect preserved work before a new plan.";
					plan.status = "blocked";
				}
			}
			if (plan.status !== "active") {
				await saveClaimedWorkPlan(parentId, token, plan, true);
				await notify();
				return { status: plan.status };
			}
			await save();
		}
		await saveClaimedWorkPlan(parentId, token, plan, true);
		return { status: plan.status };
	} catch (error) {
		plan.status = "blocked";
		await saveClaimedWorkPlan(parentId, token, plan, true)
			.then(notify)
			.catch(() => {});
		throw error;
	} finally {
		clearInterval(heartbeat);
		clearTimeout(timeout);
	}
}
