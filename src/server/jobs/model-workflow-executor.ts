import { applyApiProgress } from "#/domain/api-progress";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import { verifyDeliveryRequest } from "#/domain/delivery-auth";
import {
	MAX_WORKFLOW_MODEL_STEPS,
	type WorkflowStep,
	type WorkflowStepOutcome,
	workflowStepSchema,
} from "#/domain/model-workflow";
import { prRepairDelivery } from "#/domain/pr-repair-signal";
import { type ApiTurn, finalizeApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { stageVerifiedPrRepairSignal } from "../services/pr-repair-webhook";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

export type WorkflowStepClaim =
	| {
			kind: "claimed";
			turn: ApiTurn;
			remainingMs: number;
			/** A previous attempt of this step was interrupted and is being re-run. */
			resumed?: boolean;
	  }
	| { kind: "done"; outcome: WorkflowStepOutcome }
	| { kind: "cancelled"; turn: ApiTurn }
	| { kind: "unavailable" };

/** Receipts are claimed before any inference or tool side effect; an unknown outcome is only re-run when the owner explicitly resumes it. */
export interface WorkflowStepReceipts {
	claim(step: WorkflowStep, resume?: boolean): Promise<WorkflowStepClaim>;
	complete(step: WorkflowStep, outcome: WorkflowStepOutcome): Promise<void>;
}

/** Only signed reference-only requests reach the existing owner-scoped execution path. */
export async function executeWorkflowRequest(
	request: Request,
	secret: string,
	machines: WorkspaceMachines | (() => WorkspaceMachines),
	receipts?: WorkflowStepReceipts,
) {
	const path = new URL(request.url).pathname;
	if (
		request.method !== "POST" ||
		!["/model-step", "/pr-repair-event"].includes(path)
	)
		return new Response(null, { status: 404 });
	let body: string;
	try {
		body = await readBoundedRequestBody(request, 1024);
	} catch {
		return new Response(null, { status: 413 });
	}
	if (!(await verifyDeliveryRequest(secret, request, body)))
		return new Response(null, { status: 401 });
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return new Response(null, { status: 400 });
	}
	if (path === "/pr-repair-event") {
		if (process.env.YTIMESY_PR_REPAIR_ENABLED !== "1")
			return new Response(null, { status: 503 });
		const delivery = prRepairDelivery.safeParse(value);
		if (!delivery.success) return new Response(null, { status: 400 });
		await stageVerifiedPrRepairSignal(
			delivery.data.deliveryId,
			delivery.data.signal,
		);
		return Response.json({ accepted: true });
	}
	const parsed = workflowStepSchema.safeParse(value);
	if (!parsed.success) return new Response(null, { status: 400 });
	if (!receipts) return new Response(null, { status: 404 });
	const outcome = await executeModelStep(
		parsed.data,
		machines,
		receipts,
		request.signal,
	);
	return outcome === "unavailable"
		? new Response(null, { status: 409 })
		: Response.json({ outcome });
}

/**
 * Runs one claimed model step. "unavailable" means the step may not run here: it
 * belongs to another executor, its predecessor did not continue, or a previous
 * attempt has an unknown outcome and this caller did not ask to resume it.
 */
export async function executeModelStep(
	step: WorkflowStep,
	machines: WorkspaceMachines | (() => WorkspaceMachines),
	receipts: WorkflowStepReceipts,
	signal: AbortSignal,
	resume = false,
): Promise<WorkflowStepOutcome | "unavailable"> {
	const claim = await receipts.claim(step, resume);
	if (claim.kind === "unavailable") return "unavailable";
	if (claim.kind === "done") return claim.outcome;
	if (claim.kind === "cancelled") {
		const items = applyApiProgress(claim.turn.items, claim.turn.id, {
			type: "finish",
			reason: "cancelled",
			inputTokens: null,
			outputTokens: null,
		});
		const saved = await finalizeApiTurn(claim.turn, "cancelled", items);
		if (saved !== "cancelled") return "unavailable";
		await coordinateConversationTurn("release", {
			userId: claim.turn.user_id,
			sessionId: claim.turn.session_id,
			turnId: claim.turn.id,
			leaseId: step.leaseId,
		}).catch(() => {});
		return "cancelled";
	}
	const expired = new AbortController();
	if (claim.remainingMs === 0) expired.abort();
	const outcome = await runApiTurn(
		typeof machines === "function" ? machines() : machines,
		claim.turn,
		{
			index: step.index,
			signal: AbortSignal.any([
				signal,
				expired.signal,
				AbortSignal.timeout(claim.remainingMs),
			]),
			limitReached: step.index > MAX_WORKFLOW_MODEL_STEPS,
			resumed: claim.resumed,
		},
	);
	await receipts.complete(step, outcome);
	return outcome;
}
